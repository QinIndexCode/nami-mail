import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  Bot,
  CalendarDays,
  Check,
  CheckCheck,
  Cloud,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  Copy,
  Eye,
  EyeOff,
  FileDown,
  FileText,
  FolderSearch,
  KeyRound,
  LoaderCircle,
  MessageCircle,
  MessageCirclePlus,
  PanelLeftClose,
  Pencil,
  Plus,
  Reply,
  Search,
  SquareCheck,
  SquareSlash,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Server,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Undo2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { ApiError, api } from "./api";
import { AttachmentFileIcon } from "./mailUi";
import { presentAttachment } from "./attachmentPresentation";
import { type AgentSlashCommand, type AgentSlashSubcommand } from "@nami/agent-contracts";
import { buildSlashMenu, slashCompletionText, slashKeepsMenuOpen, slashMenuActiveIndex } from "./slashMenu";
import { AgentMark } from "./AgentMark";
import { AgentMarkdown, streamingMarkdownContent } from "./AgentMarkdown";
import { desktopBridge } from "./desktop";
import type {
  AgentBootstrap,
  AgentCitation,
  AgentConfirmation,
  AgentConversation,
  AgentMcpServerInput,
  AgentMcpServerList,
  AgentMcpServerSummary,
  AgentMessage,
  AgentProviderInput,
  AgentProviderKind,
  AgentProviderList,
  AgentProviderSummary,
  AgentScopeMode,
  AgentStreamEvent,
  AgentToolActivity,
} from "./agentTypes";
import { agentScopeFor, sameAgentScope } from "./agentContext";
import { isSupportedFile, processFile, type ProcessedFile } from "./fileProcessor";
import ThemedSelect from "./ThemedSelect";
import type { Account, AgentAccessLevel, Message } from "./types";
import { useI18n, type Translate } from "./i18n";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";

type AgentWorkspaceProps = {
  accounts: Account[];
  messages: Message[];
  currentMessage?: Message;
  onClose: () => void;
  onOpenMessage: (messageId: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  demoMode?: boolean;
  providerSettingsRequestId?: number;
  preloadedBootstrap?: AgentBootstrap;
  /** Agent permission level, persisted in app settings. */
  agentAccessLevel?: AgentAccessLevel;
  /** Persists a newly selected Agent permission level. */
  onAgentAccessLevelChange?: (level: AgentAccessLevel) => void;
};

type AgentMode = "agent" | "chat";

// Scrubber layout constants. Bars sit at a fixed vertical interval and the
// group is centred when it fits; once it overflows the track it anchors to
// the bottom so the newest messages stay visible, and hovering the top or
// bottom edge zone auto-scrolls the BAR GROUP itself (faster near the edge),
// never the transcript content.
const SCRUBBER_BAR_GAP = 12;
const SCRUBBER_EDGE_ZONE = 28;
// Delay before the hovered-bar preview bubble appears, so resting on a bar
// shows its content while quick passes across the scrubber stay quiet.
const SCRUBBER_PREVIEW_DELAY_MS = 500;
// Maximum blur (px) applied to bars as they approach the track edges.
const SCRUBBER_BLUR_MAX = 1.5;

// Bars blur near the top/bottom edge of the track so the group visually
// dissolves into the boundary instead of being clipped hard.
function scrubberBarBlur(top: number, trackHeight: number): number {
  const distance = Math.min(top, trackHeight - top);
  if (distance >= SCRUBBER_EDGE_ZONE) return 0;
  return Math.max(0, 1 - distance / SCRUBBER_EDGE_ZONE) * SCRUBBER_BLUR_MAX;
}

function newLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function currentTime(): string {
  return new Date().toISOString();
}

// Keeps per-conversation model choices across restarts.
const CONVERSATION_PROVIDERS_KEY = "nami-agent-conversation-providers";

// Keeps a conditionally rendered panel (e.g. the permission/model pickers)
// mounted long enough to run its exit transition: closing sets visible=false
// (the CSS fades/slides out) and only then unmounts the node.
function useMountedVisible(open: boolean, duration = 240): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Double rAF: the element must paint its closed state once before the
      // .show class lands, otherwise the browser batches both DOM updates into
      // a single frame and the opening transition never runs.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(first);
        if (second !== 0) cancelAnimationFrame(second);
      };
    }
    setVisible(false);
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : duration);
    return () => window.clearTimeout(timer);
  }, [open, duration]);
  return { mounted, visible };
}

/**
 * Shared upward accordion panel used by the composer permission and model
 * pickers. Wraps the options in the animated popover surface and provides
 * roving-tabindex keyboard navigation (Arrow/Home/End), focusing the checked
 * option when it opens so the menu is immediately keyboard-ready. Options are
 * native buttons, so Enter/Space activate them without extra wiring.
 */
function AgentPickerPopover({
  id,
  anchor,
  visible,
  label,
  children,
}: {
  id: string;
  anchor: "left" | "right";
  visible: boolean;
  label: string;
  children: ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const host = innerRef.current;
    if (!host) return;
    const checked = host.querySelector<HTMLButtonElement>('.agent-popover-option[aria-checked="true"]');
    const target = checked ?? host.querySelector<HTMLButtonElement>(".agent-popover-option");
    target?.focus({ preventScroll: true });
  }, [visible]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const host = innerRef.current;
    if (!host) return;
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>(".agent-popover-option"));
    if (options.length === 0) return;
    const current = document.activeElement;
    const index = options.indexOf(current as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = index === -1 ? 0 : Math.min(index + 1, options.length - 1);
    else if (event.key === "ArrowUp") next = index === -1 ? options.length - 1 : Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else next = options.length - 1;
    event.preventDefault();
    options[next]?.focus({ preventScroll: true });
  };

  return (
    <div id={id} className={`agent-popover anchor-${anchor}${visible ? " show" : ""}`} role="menu" aria-label={label} onKeyDown={handleKeyDown}>
      <div className="agent-popover-inner" ref={innerRef}>
        {children}
      </div>
    </div>
  );
}

function shortDate(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" }).format(date);
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const time = minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, "0")}`
    : `${seconds}s`;
  return time;
}

/**
 * Revoked message ids are kept per conversation in localStorage so they survive
 * restarts (the agent service only stores the raw conversation, not the local
 * revocation state).
 */
const REVOKED_STORAGE_KEY = "nami.agent.revokedByConversation";

/** How long the "已撤回信息" notice stays above the composer before fading. */
const REVOKE_NOTICE_SECONDS = 10;

function readRevokedIds(conversationId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(REVOKED_STORAGE_KEY);
    if (!raw) return new Set();
    const byConversation = JSON.parse(raw) as Record<string, string[]>;
    return new Set(byConversation[conversationId] ?? []);
  } catch {
    return new Set();
  }
}

function writeRevokedIds(conversationId: string, ids: Set<string>): void {
  try {
    const raw = window.localStorage.getItem(REVOKED_STORAGE_KEY);
    const byConversation = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    byConversation[conversationId] = [...ids];
    window.localStorage.setItem(REVOKED_STORAGE_KEY, JSON.stringify(byConversation));
  } catch {
    // Storage unavailable — revocation stays in-memory for this session.
  }
}

/** The panel reopens onto the conversation that was open when it closed. */
const LAST_ACTIVE_CONVERSATION_KEY = "nami.agent.lastConversation";

function readLastActiveConversationId(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVE_CONVERSATION_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A conversation whose newest turn has no assistant reply yet (the last
 * message is the user's) may still be finishing on the server after the
 * panel closed — closing the panel does not cancel the run.
 */
export function lastMessageIsUnanswered(conversation: AgentConversation): boolean {
  const last = conversation.messages[conversation.messages.length - 1];
  return Boolean(last && last.role === "user");
}

/** True when the newest turn has an assistant reply that is still streaming
 *  (a re-opened panel renders the in-flight snapshot and should keep polling
 *  until the turn persists as complete). */
export function lastMessageIsStreaming(conversation: AgentConversation): boolean {
  const last = conversation.messages[conversation.messages.length - 1];
  return Boolean(last && last.role === "assistant" && last.state === "streaming");
}

function applyRevokedMarks(conversation: AgentConversation): AgentConversation {
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
 * that was followed by a successful assistant turn is outdated (the turn has
 * moved on, e.g. a retry succeeded) and is no longer shown.
 */
function purgeStaleErrors(conversation: AgentConversation): AgentConversation {
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

function sourceLabel(citation: AgentCitation): string {
  return citation.sender ? `${citation.sender} · ${citation.subject}` : citation.subject;
}

/** Copies text to the clipboard, falling back to a hidden textarea + execCommand
 *  when the async Clipboard API is unavailable (non-secure contexts). */
async function copyToClipboard(content: string): Promise<void> {
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
 * The "来源邮件" panel lists distinct source messages, not search chunks.
 * Deduplicate by `messageId` (falling back to the citation id) so the same
 * mail can never appear twice, even if the stream re-emits a citation or two
 * retrieval paths produce one for the same message. Server-side RAG already
 * dedupes by message, so this is a defensive guard, not a data fix.
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

function truncateForPreview(text: string, maxLen = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "…";
}

function truncateForContext(text: string, headLen = 200, tailLen = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= headLen + tailLen + 5) return clean;
  return clean.slice(0, headLen) + " …" + clean.slice(-tailLen);
}

function messageWithEvent(message: AgentMessage, event: AgentStreamEvent): AgentMessage {
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
        // A user-cancelled reply is a truncation, not a finished answer: flag it
        // so the transcript reads as stopped and retry affordances stay usable.
        ...(event.reason === "cancelled" ? { interrupted: true } : {}),
      };
    default:
      return message;
  }
}

/**
 * Folds an in-flight assistant message into a clearly "interrupted" state when
 * the user sends a new message while the agent is still streaming. It:
 *   - flags the message as interrupted so the partial reply reads as stopped;
 *   - marks every tool that was still running or waiting for confirmation as
 *     failed ("interrupted") so no activity is left spinning forever;
 *   - expires a pending confirmation so it cannot be acted on after the run.
 */
/**
 * A run that may outlive the conversation currently being viewed. When the user
 * switches away mid-reply, the run keeps streaming into this buffer instead of
 * touching the UI (rendering to a transcript nobody is looking at). Re-entering
 * the conversation replays the buffered events so the reply appears exactly
 * where it left off — the server's `inFlight` snapshot plus the missing tail —
 * then live events resume the same row. Terminal runs are removed once the
 * server has persisted the final turn, so re-entry just renders the persisted
 * transcript.
 */
type SessionStream = {
  conversationId: string;
  assistantMessageId: string;
  controller: AbortController;
  /** text_delta / citation / tool / confirmation / error / completed deltas. */
  events: AgentStreamEvent[];
  /** Latest status message while the run was in the background. */
  status: string | null;
  /** Memory suggestions collected while the run was in the background. */
  suggestions: string[];
  /** True once a terminal event (completed/error) was received. */
  done: boolean;
};

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
 * confirmation and releases the tool that was waiting for it (completed with
 * an approval label on approval, failed on rejection). Messages without the
 * matching confirmation are returned unchanged.
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
 * waiting for it. Messages without the matching confirmation are returned
 * unchanged.
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

const toolLabelKeys: Readonly<Record<string, string>> = {
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

/**
 * Builds a fully populated sample conversation for demo mode so the transcript
 * styling (tool cards, citations, confirmations, quotes, attachments, errors,
 * streaming state) can be reviewed without a backend.
 */
function createDemoConversation(): AgentConversation {
  const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
  const tool = (id: string, toolName: string, title: string, state: AgentToolActivity["state"], extra?: Partial<AgentToolActivity>): AgentToolActivity => ({
    id,
    toolName,
    title,
    state,
    ...extra,
  });
  const citation = (id: string, subject: string, sender: string, sentAt: string, excerpt: string, messageId = "demo-mail-1"): AgentCitation => ({
    id,
    messageId,
    accountId: "account-1",
    subject,
    sender,
    sentAt,
    excerpt,
    confidence: 0.97,
  });

return {
    id: "demo-conversation-1",
    title: "季度回顾会议准备",
    preview: "明天上午还有什么安排吗？",
    updatedAt: minutesAgo(1),
    scope: { mode: "all_accounts", accountIds: ["account-1"], messageIds: [] },
    providerId: "demo-ollama",
    messages: [
      {
        id: "demo-msg-0",
        role: "system",
        content: "已恢复会话记忆：与星辰科技的合作往来、本周 3 封待办邮件、2 个待确认日程。",
        createdAt: minutesAgo(59),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-1",
        role: "user",
        content: "早上好，帮我看看今天有哪些需要关注的邮件？",
        createdAt: minutesAgo(58),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-2",
        role: "assistant",
        content: "今天有 3 封值得关注的邮件：\n\n1. **星辰科技**确认了季度回顾会议，并把时间改到了周二下午 4 点；\n2. **供应商发票**已上传附件，等待你确认付款；\n3. **安全通知**提醒本周将轮换部分账户密码。\n\n需要我展开哪一封？",
        createdAt: minutesAgo(56),
        state: "complete",
        citations: [
          citation("demo-cite-1", "季度回顾会议时间调整", "星辰科技 <meeting@xingchen.example>", minutesAgo(120), "季度回顾会议调整至周二 16:00，届时请提前准备供应商报价对比表。"),
          citation("demo-cite-2", "6 月供应商发票", "财务部 <finance@nami.example>", minutesAgo(300), "附上 6 月供应商发票，请在月底前完成确认。"),
        ],
        toolActivities: [
          tool("demo-tool-1", "accounts.list", "accounts.list", "completed"),
          tool("demo-tool-2", "messages.list", "messages.list", "completed"),
          tool("demo-tool-3", "messages.get", "messages.get", "completed", { summary: "3 封邮件详情" }),
        ],
      },
      {
        id: "demo-msg-3",
        role: "user",
        content: "那封星辰科技的邮件说要提前讨论供应商报价，附件里是我整理的数据，帮我对一下。",
        createdAt: minutesAgo(40),
        state: "complete",
        citations: [],
        toolActivities: [],
        quote: "季度回顾会议调整至周二 16:00，届时请提前准备供应商报价对比。",
        attachments: [
          { name: "季度数据.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", path: "C:\\Users\\demo\\Downloads\\季度数据.xlsx", token: "out_demo_quarterly" },
        ],
      },
      {
        id: "demo-msg-4",
        role: "assistant",
        content: "已结合你上传的数据与历史邮件核对：\n\n- 星辰科技在 6 月邮件中提及的供应商报价为 **12.8 万**，与你的数据表一致；\n- 本次邮件把讨论时间从 14:00 改到 **16:00**，原因是采购团队上午有评审会；\n- 建议准备：报价对比表 + 上半年采购量统计表。",
        createdAt: minutesAgo(38),
        state: "complete",
        citations: [
          citation("demo-cite-3", "6 月供应商报价沟通", "星辰科技 <purchase@xingchen.example>", minutesAgo(3000), "供应商报价 12.8 万，待月度会议确认。", "demo-mail-2"),
        ],
        toolActivities: [
          tool("demo-tool-4", "rag.search", "rag.search", "completed", { summary: "匹配到 3 条历史记录" }),
          tool("demo-tool-5", "messages.get", "messages.get", "completed"),
        ],
      },
      {
        id: "demo-msg-5",
        role: "user",
        content: "帮我起草一封回复，确认我们周二下午 4 点会参加，并询问需要准备什么材料。",
        createdAt: minutesAgo(30),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-6",
        role: "assistant",
        content: "草稿已创建，等你确认后就可以发送。需要修改措辞或收件人时告诉我即可。",
        createdAt: minutesAgo(28),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-6", "mail.draft.create", "mail.draft.create", "completed"),
        ],
        confirmation: {
          id: "demo-confirm-1",
          title: "创建邮件草稿",
          summary: "助手请求创建一封新草稿",
          fields: [
            { label: "账户", value: "hello@nami.example" },
            { label: "收件人", value: "meeting@xingchen.example" },
            { label: "主题", value: "确认参加季度回顾会议" },
            { label: "正文", value: "确认参加周二 16:00 的季度回顾会议，请告知需要提前准备的材料。" },
          ],
          expiresAt: minutesAgo(28),
          state: "approved",
        },
      },
      {
        id: "demo-msg-7",
        role: "user",
        content: "在日历上创建一个提醒：周二 15:30 提前准备会议材料。",
        createdAt: minutesAgo(20),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-8",
        role: "assistant",
        content: "已添加日程「准备季度回顾材料」，周二 15:30–16:00。",
        createdAt: minutesAgo(18),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-7", "calendar.create", "calendar.create", "awaiting_confirmation"),
        ],
        confirmation: {
          id: "demo-confirm-3",
          title: "创建日历日程",
          summary: "助手请求在日历中添加新日程",
          fields: [
            { label: "日程", value: "准备季度回顾材料" },
            { label: "时间", value: "周二 15:30–16:00" },
          ],
          expiresAt: minutesAgo(-42),
          state: "pending",
        },
      },
      {
        id: "demo-msg-9",
        role: "user",
        content: "另外把之前那个「产品评审」日程删掉吧。",
        createdAt: minutesAgo(15),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-10",
        role: "assistant",
        content: "好的，已取消删除「产品评审」，该日程保持不变。",
        createdAt: minutesAgo(13),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-8", "calendar.delete", "calendar.delete", "completed"),
        ],
        confirmation: {
          id: "demo-confirm-2",
          title: "删除日历日程",
          summary: "助手请求删除日程「产品评审」",
          fields: [
            { label: "日程", value: "产品评审" },
            { label: "时间", value: "周三 10:00–11:00" },
          ],
          expiresAt: minutesAgo(13),
          state: "rejected",
        },
      },
      {
        id: "demo-msg-11",
        role: "user",
        content: "好的，那直接把这封确认邮件发出去。",
        createdAt: minutesAgo(10),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-12",
        role: "assistant",
        content: "发送遇到问题：SMTP 服务器暂时不可用，草稿仍安全保存在草稿箱，可以稍后重试。",
        createdAt: minutesAgo(8),
        state: "error",
        citations: [],
        toolActivities: [
          tool("demo-tool-9", "messages.send", "messages.send", "failed", {
            error: { code: "HOST_UNAVAILABLE", message: "SMTP 服务器暂时不可用（网络中断）", retryable: true },
          }),
        ],
        error: { code: "HOST_UNAVAILABLE", message: "SMTP 服务器暂时不可用（网络中断）", suggestion: "检查网络连接后重试，或稍后再发送", retryable: true },
      },
      {
        id: "demo-msg-13",
        role: "user",
        content: "重试发送。",
        createdAt: minutesAgo(6),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-14",
        role: "assistant",
        content: "已发送：确认参加季度回顾会议（收件人 meeting@xingchen.example）。",
        createdAt: minutesAgo(5),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-10", "messages.send", "messages.send", "completed"),
        ],
      },
      {
        id: "demo-msg-15",
        role: "user",
        content: "明天上午还有什么安排吗？",
        createdAt: minutesAgo(2),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-16",
        role: "assistant",
        content: "",
        createdAt: minutesAgo(1),
        state: "streaming",
        citations: [],
        toolActivities: [],
      },
    ],
  };
}

function AgentToolCard({ activity }: { activity: AgentToolActivity }) {
  const { t } = useI18n();
  const icon = activity.state === "failed" ? <CircleAlert size={15} /> : activity.state === "completed" ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />;
  const title = toolLabelKeys[activity.toolName] ? t(toolLabelKeys[activity.toolName]) : activity.title;
  const summary = activity.state === "failed"
    ? activity.error?.code === "INTERRUPTED"
      ? t("agent.interrupted")
      : activity.error?.code?.startsWith("CONFIRMATION_")
        ? activity.error.message
        : t("agent.tool.failed")
    : activity.state === "completed"
      ? activity.summary ?? t("agent.tool.completed")
      : activity.state === "awaiting_confirmation"
        ? t("agent.confirmation.waiting")
        : t("agent.tool.running");
  return (
    <div className={`agent-tool-card ${activity.state}`}>
      <span className="agent-tool-icon" aria-hidden="true">{icon}</span>
      <span className="agent-tool-copy"><strong>{title}</strong><small>{summary}</small></span>
      {activity.state === "awaiting_confirmation" && <span className="agent-tool-waiting">{t("agent.confirmation.waiting")}</span>}
    </div>
  );
}

// Tool activities stay collapsed into a quiet one-line summary — even while
// running — so a turn's tool calls never dominate the conversation. A FINAL
// failure — the newest activity failed — in the LATEST turn expands the list
// to make the error visible (earlier failures followed by successful tools do
// not pin it open); once the user starts a new turn (superseded), the old
// warning folds back into its summary automatically. The user can always fold
// the list back down; the failed count keeps the error visible on the summary
// row, and a fresh failure pops it open again. The summary row stays in place
// as an accordion header so the fold is a smooth height transition.
export const AgentToolList = memo(function AgentToolListInner({ activities, superseded = false }: { activities: AgentToolActivity[]; superseded?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // Dismissal is keyed to the latest activity so a NEW failure (a later
  // activity becomes the latest) pops the list open again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const latest = activities[activities.length - 1];
  const autoExpanded = latest?.state === "failed" && !superseded && dismissedKey !== latest.id;
  const open = expanded || autoExpanded;
  const failedCount = activities.filter((activity) => activity.state === "failed").length;
  const runningCount = activities.filter((activity) => activity.state === "running" || activity.state === "awaiting_confirmation").length;
  // Only a DONE failure can be dismissed; a running tool that fails later must
  // still pop the list open again.
  const collapse = () => {
    setExpanded(false);
    if (latest?.state === "failed") setDismissedKey(latest.id);
  };

  return (
    <div className={`agent-tool-list${open ? " open" : ""}`}>
      <button type="button" className="agent-tool-summary" aria-expanded={open} onClick={() => (open ? collapse() : setExpanded(true))}>
        <Wrench size={13} />
        {/* The count renders as a rolling odometer digit: only the number spins
            (like a taximeter) when a new tool call lands. The full sentence is
            kept for screen readers; the visual is the prefix + rolling digit +
            suffix so the surrounding text never moves. */}
        <span className="agent-tool-summary-label">
          <span className="visually-hidden">{t("agent.tool.summary", { count: activities.length })}</span>
          <span className="agent-tool-summary-visual" aria-hidden="true">
            <span className="agent-tool-summary-prefix">{t("agent.tool.summaryPrefix")}</span>
            <span className="agent-tool-count-window">
              <span className="agent-tool-count-strip" style={{ transform: `translateY(${-activities.length}em)` }}>
                {Array.from({ length: Math.max(10, activities.length + 1) }, (_, digit) => (
                  <span key={digit} className="agent-tool-count-digit">{digit}</span>
                ))}
              </span>
            </span>
            <span className="agent-tool-summary-suffix">{t("agent.tool.summarySuffix")}</span>
          </span>
        </span>
        <span className="agent-tool-summary-chips">{failedCount > 0 && <em className="agent-tool-summary-failed">{t("agent.tool.failedCount", { count: failedCount })}</em>}{runningCount > 0 && <em className="agent-tool-summary-running">{t("agent.tool.runningCount", { count: runningCount })}</em>}</span>
        <ChevronDown size={13} className="agent-tool-summary-chevron" />
      </button>
      <div className="agent-tool-collapse" aria-hidden={!open}>
        <div className="agent-tool-collapse-inner">
          {activities.map((activity) => <AgentToolCard key={activity.id} activity={activity} />)}
          <button type="button" className="agent-tool-toggle" onClick={collapse}>{t("agent.tool.collapse")}</button>
        </div>
      </div>
    </div>
  );
});

function AgentConfirmationCard({
  confirmation,
  desktopConfirmationAvailable,
  resolutionError,
  onDecision,
  expiresAt,
  onExpire,
}: {
  confirmation: AgentConfirmation;
  desktopConfirmationAvailable: boolean;
  resolutionError?: string;
  /** Local decision handler (demo mode) — real builds resolve through the desktop bridge. */
  onDecision?: (decision: "approve" | "reject") => void;
  /** Deadline (epoch ms) driving the local ticking countdown. */
  expiresAt?: number;
  /** Called once when the deadline passes while the card is mounted. */
  onExpire?: () => void;
}) {
  const { locale, t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  useEffect(() => {
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!expiredRef.current && current >= expiresAt) {
        expiredRef.current = true;
        onExpire?.();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, onExpire]);
  const decisionEnabled = Boolean(onDecision);
  const resolve = (decision: "approve" | "reject") => {
    if (leaving) return;
    setLeaving(true);
    // Let the collapse animation finish before the card unmounts.
    window.setTimeout(() => onDecision?.(decision), 260);
  };
  const remainingMs = expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt - now : 0;
  return (
    <section
      className={`agent-confirmation-card${leaving ? " leaving" : ""}`}
      aria-label={confirmation.title}
      data-nami-agent-confirmation-card
      data-nami-agent-confirmation-id={confirmation.id}
    >
      <div className="agent-confirmation-heading"><ShieldAlert size={17} /><span><strong>{confirmation.title}</strong><small>{confirmation.summary}</small></span><small className="agent-confirmation-expiry">{remainingMs > 0
        ? t("agent.confirmation.expiresIn", { time: formatCountdown(remainingMs) })
        : t("agent.confirmation.expires", { time: shortDate(confirmation.expiresAt, locale) })}</small></div>
      <dl>
        {confirmation.fields.map((field) => <div key={`${field.label}:${field.value}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
      </dl>
      <div className="agent-confirmation-actions">
        <button className="secondary-button" type="button" disabled={!desktopConfirmationAvailable && !decisionEnabled} data-nami-agent-confirmation-id={confirmation.id} data-nami-agent-confirmation-decision="reject" onClick={decisionEnabled ? () => resolve("reject") : undefined}>{t("agent.confirmation.reject")}</button>
        <button className="primary-button" type="button" disabled={!desktopConfirmationAvailable && !decisionEnabled} data-nami-agent-confirmation-id={confirmation.id} data-nami-agent-confirmation-decision="approve" onClick={decisionEnabled ? () => resolve("approve") : undefined}><CheckCheck size={15} />{t("agent.confirmation.approve")}</button>
      </div>
      {resolutionError && <div className="agent-message-error" role="alert"><CircleAlert size={15} /><span>{resolutionError}</span></div>}
    </section>
  );
}

// Owns its own 1 s tick so the countdown does not re-render the workspace.
function RevokeNotice({ until, onExpire }: { until: number; onExpire: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!expiredRef.current && current >= until) {
        expiredRef.current = true;
        onExpire();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until, onExpire]);
  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <div className="agent-revoke-notice" role="status">
      <span>{t("agent.message.revokeNotice")}</span>
      <em aria-hidden="true">{remaining}s</em>
    </div>
  );
}

function AgentRecallButton({
  onRevoke,
  label,
  confirmLabel,
  disabled,
}: {
  onRevoke: () => void;
  label: string;
  confirmLabel: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(armTimerRef.current), []);
  const handleClick = () => {
    if (armed) {
      window.clearTimeout(armTimerRef.current);
      setArmed(false);
      onRevoke();
      return;
    }
    setArmed(true);
    armTimerRef.current = window.setTimeout(() => setArmed(false), 3200);
  };
  return (
    <button
      type="button"
      className={`agent-corner-button recall${armed ? " armed" : ""}`}
      disabled={disabled}
      onClick={disabled ? undefined : handleClick}
      aria-label={label}
      data-tooltip={armed ? confirmLabel : label}
    >
      {armed ? <span className="agent-recall-arm">{confirmLabel}</span> : <Undo2 size={12} />}
    </button>
  );
}

const AgentScrubberBar = memo(function AgentScrubberBarInner({
  hovered,
  top,
  width,
  blur,
}: {
  hovered: boolean;
  top: number;
  width: number;
  blur: number;
}) {
  return (
    <span
      className={`agent-scrubber-bar${hovered ? " hovered" : ""}`}
      style={{
        top: `${top}px`,
        width: `${width}px`,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
      }}
    />
  );
});

const ollamaEndpointSuggestion = "http://127.0.0.1:11434/v1";

/** Copy button with a transient checkmark: copies, shows a check, then returns
 *  to the copy icon so repeated copies stay possible. The row keeps rendering
 *  only this tiny control, isolated from the memoised message row. */
function CopyMessageButton({ content, label }: { content: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const handleCopy = () => {
    void copyToClipboard(content);
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      type="button"
      className={`agent-corner-button copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
      aria-label={label}
      data-tooltip={label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/**
 * Renders an assistant turn's body. While it is streaming, the content is
 * parsed and rendered live by `AgentMarkdown` (a mature react-markdown-based
 * renderer) instead of showing plain text, so bold/headings/code appear as the
 * model types them. `streamingMarkdownContent` guards against an unfinished
 * code fence swallowing the tail; once the turn completes, the full content is
 * parsed with no truncation.
 */
const AgentMessageContent = memo(function AgentMessageContentInner({ content, streaming }: { content: string; streaming: boolean }) {
  if (streaming) {
    return <AgentMarkdown content={streamingMarkdownContent(content)} />;
  }
  return <AgentMarkdown content={content} />;
});

type AgentMessageRowProps = {
  message: AgentMessage;
  /** Whether a newer user turn follows this message (supersedes its warnings). */
  superseded: boolean;
  /** Live provider status text (e.g. "retrying") shown in the thinking line. */
  statusMessage?: string | null;
  locale: string;
  t: Translate;
  onOpenAttachment: (path?: string) => void;
  onRevoke: (messageId: string) => void;
  onRetry: () => void;
  onUserMessageRef: (messageId: string, node: HTMLElement | null) => void;
};

/**
 * One transcript message. Isolated with React.memo so a streaming update —
 * which only mutates the single in-flight message object — re-renders that row
 * alone instead of re-parsing every historic message's markdown. Callbacks and
 * the i18n helpers must keep stable identities for the memo to hold.
 */
export const AgentMessageRow = memo(function AgentMessageRowInner({
  message,
  superseded,
  statusMessage,
  locale,
  t,
  onOpenAttachment,
  onRevoke,
  onRetry,
  onUserMessageRef,
}: AgentMessageRowProps) {
  const userMessageRef = useCallback((node: HTMLElement | null) => {
    onUserMessageRef(message.id, node);
  }, [message.id, onUserMessageRef]);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  // A revoked message disappears from the transcript entirely; the "已撤回信息"
  // notice lives above the composer instead of leaving a placeholder row.
  if (message.revoked) return null;
  const allAttachments = message.attachments ?? [];
  const attachmentOverflow = allAttachments.length - 5;
  const visibleAttachments = attachmentsExpanded || attachmentOverflow <= 0 ? allAttachments : allAttachments.slice(0, 5);
  return (
    <article
      className={`agent-message ${message.role} ${message.state === "streaming" ? "streaming" : ""}${message.interrupted ? " interrupted" : ""}`}
      ref={message.role === "user" ? userMessageRef : undefined}
    >
      {!message.revoked && (
        <>
          {message.quote && <div className="agent-message-quote"><span className="agent-quote-mark" aria-hidden="true">"</span><span className="agent-quote-text">{truncateForPreview(message.quote)}</span><span className="agent-quote-mark" aria-hidden="true">"</span></div>}
          {message.content ? <AgentMessageContent content={message.content} streaming={message.state === "streaming"} /> : message.state === "streaming" && <div className="agent-thinking"><span className="agent-thinking-dots" aria-hidden="true"><span className="agent-thinking-dot" /><span className="agent-thinking-dot" /><span className="agent-thinking-dot" /></span>{statusMessage || t("agent.message.thinking")}</div>}
          {message.attachments && message.attachments.length > 0 && <div className="agent-message-attachments">{visibleAttachments.map((attachment, index) => { const presentation = presentAttachment(attachment.name, attachment.type, t); return <button key={`${attachment.name}-${index}`} type="button" className="agent-message-attachment" onClick={() => onOpenAttachment(attachment.path)} data-tooltip={attachment.path ?? attachment.name}><AttachmentFileIcon kind={presentation.kind} /><span>{attachment.name}</span></button>; })}{attachmentOverflow > 0 && <button type="button" className="agent-message-attachment is-more" aria-expanded={attachmentsExpanded} onClick={() => setAttachmentsExpanded((value) => !value)}>{attachmentsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}<span>{attachmentsExpanded ? t("agent.message.collapseAttachments") : t("agent.message.expandAttachments", { count: attachmentOverflow })}</span></button>}</div>}
          {message.toolActivities.length > 0 && <AgentToolList activities={message.toolActivities} superseded={superseded} />}
          {message.error && <div className="agent-message-error"><CircleAlert size={15} /><span>{message.error.message}{message.error.suggestion ? ` ${message.error.suggestion}` : ""}</span>{message.error.retryable && <button type="button" onClick={onRetry}>{t("agent.message.retry")}</button>}</div>}
        </>
      )}
      <div className="agent-message-meta">{message.role === "system" && <span className="agent-message-role">{t("agent.message.system")}</span>}{message.interrupted && <span className="agent-message-interrupted">{t("agent.message.interrupted")}</span>}<time>{shortDate(message.createdAt, locale)}</time>{!message.revoked && <span className="agent-message-actions">{message.content && <CopyMessageButton content={message.content} label={t("agent.message.copy")} />}{message.role === "user" && <AgentRecallButton disabled={!message.content || message.state === "streaming"} onRevoke={() => onRevoke(message.id)} label={t("agent.message.revoke")} confirmLabel={t("agent.message.revokeConfirm")} />}</span>}</div>
    </article>
  );
});

type ProviderKindMetadata = {
  endpointSuggestion: string;
  endpointHintKey: string;
  modelPlaceholder: string;
  embeddingModelPlaceholder?: string;
};

/** Per-protocol defaults shown in the provider form (placeholders and pre-fill). */
const providerKindMetadata: Record<AgentProviderKind, ProviderKindMetadata> = {
  "openai-compatible": {
    endpointSuggestion: "",
    endpointHintKey: "agent.providers.fields.endpointHint",
    modelPlaceholder: "gpt-4.1-mini",
    embeddingModelPlaceholder: "text-embedding-3-small",
  },
  ollama: {
    endpointSuggestion: ollamaEndpointSuggestion,
    endpointHintKey: "agent.providers.fields.ollamaEndpointHint",
    modelPlaceholder: "llama3.2",
    embeddingModelPlaceholder: "nomic-embed-text",
  },
  anthropic: {
    endpointSuggestion: "https://api.anthropic.com",
    endpointHintKey: "agent.providers.fields.endpointHintAnthropic",
    modelPlaceholder: "claude-sonnet-4-5",
  },
  gemini: {
    endpointSuggestion: "https://generativelanguage.googleapis.com/v1beta",
    endpointHintKey: "agent.providers.fields.endpointHintGemini",
    modelPlaceholder: "gemini-2.5-flash",
  },
  "openai-responses": {
    endpointSuggestion: "https://api.openai.com/v1",
    endpointHintKey: "agent.providers.fields.endpointHintOpenAiResponses",
    modelPlaceholder: "gpt-4.1",
  },
};

type ProviderForm = {
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  embeddingModel: string;
  apiKey: string;
  clearApiKey: boolean;
  timeoutMs: string;
  allowCloudMailContent: boolean;
  makeDefault: boolean;
};

function configuredProviderId(providers: readonly AgentProviderSummary[], defaultProviderId: string | null): string {
  // The default provider wins even when it is not yet configured (e.g. the API
  // key was left empty or the connection check has not run): the composer must
  // reflect the user's explicit default choice. Configured providers still
  // fill in when no default exists.
  return providers.find((provider) => provider.id === defaultProviderId)?.id
    ?? providers.filter((provider) => provider.configured)[0]?.id
    ?? providers[0]?.id
    ?? "";
}

function providerFormFor(provider: AgentProviderSummary | null, defaultProviderId: string | null): ProviderForm {
  if (!provider) {
    return {
      label: "",
      kind: "openai-compatible",
      endpoint: "",
      model: "",
      embeddingModel: "",
      apiKey: "",
      clearApiKey: false,
      timeoutMs: "45000",
      allowCloudMailContent: false,
      makeDefault: defaultProviderId === null,
    };
  }
  return {
    label: provider.label,
    kind: provider.kind,
    endpoint: provider.endpoint,
    model: provider.model,
    embeddingModel: provider.embeddingModel ?? "",
    apiKey: "",
    clearApiKey: false,
    timeoutMs: String(provider.timeoutMs),
    allowCloudMailContent: provider.cloudContentConsent,
    makeDefault: provider.id === defaultProviderId,
  };
}

function providerVisualState(provider: AgentProviderSummary): "needsSetup" | "configurationComplete" | "verified" | "degraded" | "unavailable" {
  if (!provider.configured) return "needsSetup";
  if (provider.health?.state === "ready") return "verified";
  if (provider.health?.state === "degraded") return "degraded";
  if (provider.health?.state === "unavailable") return "unavailable";
  return "configurationComplete";
}

function AgentProviderSettings({
  open,
  pane,
  onPaneChange,
  initialProviders,
  initialDefaultProviderId,
  onClose,
  onProvidersChanged,
  restoreFocusRef,
}: {
  open: boolean;
  pane: AgentSettingsPane;
  onPaneChange: (pane: AgentSettingsPane) => void;
  initialProviders: AgentProviderSummary[];
  initialDefaultProviderId: string | null;
  onClose: () => void;
  onProvidersChanged: (providers: AgentProviderList) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const [providers, setProviders] = useState<AgentProviderSummary[]>(initialProviders);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(initialDefaultProviderId);
  const initialProvidersRef = useRef(initialProviders);
  const initialDefaultProviderIdRef = useRef(initialDefaultProviderId);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => providerFormFor(null, initialDefaultProviderId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const selectedProviderIdRef = useRef<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const isDefaultProvider = Boolean(selectedProvider && selectedProvider.id === defaultProviderId);
  const isOllama = form.kind === "ollama";
  // "Send selected mail to the model" is only meaningful for remote endpoints:
  // a loopback service (Ollama, LM Studio, …) never leaves the machine, so the
  // switch is locked off there regardless of kind.
  const isLocalEndpoint = useMemo(() => {
    try {
      const hostname = new URL(form.endpoint.trim()).hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    } catch {
      return false;
    }
  }, [form.endpoint]);
  // These kinds serve the OpenAI-compatible /embeddings endpoint on the same
  // origin as chat, so the optional embedding model is exposed for them.
  const embeddingCapable = form.kind === "openai-compatible" || form.kind === "ollama";
  const kindMeta = providerKindMetadata[form.kind];

  const healthFeedback = (provider: AgentProviderSummary | undefined): string => {
    const errorCode = provider?.health?.error?.code;
    if (errorCode === "PROVIDER_AUTH_FAILED") return t("agent.providers.checkError.auth");
    if (errorCode === "PROVIDER_TIMEOUT") return t("agent.providers.checkError.timeout");
    if (errorCode === "PROVIDER_UNAVAILABLE") return t("agent.providers.checkError.unavailable");
    if (errorCode === "PROVIDER_RATE_LIMITED") return t("agent.providers.checkError.rateLimited");
    return t("agent.providers.checkError.failed");
  };

  const requestFeedback = (error: unknown, fallback: string): string => {
    if (error instanceof ApiError) {
      if (error.code === "PROVIDER_AUTH_FAILED") return t("agent.providers.checkError.auth");
      if (error.code === "PROVIDER_CHANGED") return t("agent.providers.checkError.changed");
      if (error.code === "local_service_unavailable") return t("agent.providers.checkError.localService");
      return error.message || fallback;
    }
    return fallback;
  };

  // The render that opens this panel carries the latest bootstrap summary.
  // Subsequent provider-list updates must not reset an in-progress form.
  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  const selectProvider = useCallback((provider: AgentProviderSummary | null, nextDefaultProviderId = defaultProviderId) => {
    setSelectedProviderId(provider?.id ?? null);
    setForm(providerFormFor(provider, nextDefaultProviderId));
    setDeletePendingId(null);
    setKeyVisible(false);
    setNotice(null);
  }, [defaultProviderId]);

  const onProvidersChangedRef = useRef(onProvidersChanged);
  onProvidersChangedRef.current = onProvidersChanged;

  const applyProviderList = useCallback((snapshot: AgentProviderList, preferredProviderId: string | null = null) => {
    setProviders(snapshot.items);
    setDefaultProviderId(snapshot.defaultProviderId);
    onProvidersChangedRef.current(snapshot);
    const selected = (preferredProviderId ? snapshot.items.find((provider) => provider.id === preferredProviderId) : undefined)
      ?? snapshot.items.find((provider) => provider.id === selectedProviderIdRef.current)
      ?? snapshot.items.find((provider) => provider.id === snapshot.defaultProviderId)
      ?? snapshot.items[0]
      ?? null;
    setSelectedProviderId(selected?.id ?? null);
    setForm(providerFormFor(selected, snapshot.defaultProviderId));
    setDeletePendingId(null);
    setKeyVisible(false);
  }, []);

  const refreshProviders = useCallback(async (preferredProviderId: string | null = null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await api.agentProviders();
      applyProviderList(snapshot, preferredProviderId);
      return snapshot;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.providers.loadFailed"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyProviderList, t]);

  useEffect(() => {
    if (!open) return;
    setProviders(initialProvidersRef.current);
    setDefaultProviderId(initialDefaultProviderIdRef.current);
    setSelectedProviderId(null);
    setForm(providerFormFor(null, initialDefaultProviderIdRef.current));
    setLoadError(null);
    setNotice(null);
    setDeletePendingId(null);
    void refreshProviders();
  }, [open, refreshProviders]);

  const { closing, requestClose } = useDismissTransition(() => {
    onClose();
  });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".select-control")?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [requestClose, open, saving]);

  useDialogFocus(open || closing, dialogRef, { restoreFocusRef });

  const updateForm = <Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
    setDeletePendingId(null);
  };

  const updateKind = (kind: AgentProviderKind) => {
    setForm((current) => ({
      ...current,
      kind,
      endpoint: !current.endpoint.trim() ? providerKindMetadata[kind].endpointSuggestion : current.endpoint,
      allowCloudMailContent: kind === "ollama" ? false : current.allowCloudMailContent,
    }));
    setNotice(null);
    setDeletePendingId(null);
  };

  const validationMessage = useMemo(() => {
    if (!form.label.trim()) return t("agent.providers.validation.label");
    if (!form.endpoint.trim()) return t("agent.providers.validation.endpoint");
    try {
      const endpoint = new URL(form.endpoint.trim());
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return t("agent.providers.validation.endpoint");
    } catch {
      return t("agent.providers.validation.endpoint");
    }
    if (!form.model.trim()) return t("agent.providers.validation.model");
    const timeoutMs = Number(form.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) return t("agent.providers.validation.timeout");
    return null;
  }, [form.endpoint, form.label, form.model, form.timeoutMs, t]);

  const saveProvider = async () => {
    if (saving || validationMessage) return;
    const timeoutMs = Number(form.timeoutMs);
    const input: AgentProviderInput = {
      label: form.label.trim(),
      kind: form.kind,
      endpoint: form.endpoint.trim(),
      model: form.model.trim(),
      ...(form.embeddingModel.trim() ? { embeddingModel: form.embeddingModel.trim() } : {}),
      timeoutMs,
      allowCloudMailContent: isOllama || isLocalEndpoint ? false : form.allowCloudMailContent,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.clearApiKey ? { clearApiKey: true } : {}),
      ...(form.makeDefault ? { makeDefault: true } : {}),
    };
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    let saved: AgentProviderSummary | undefined;
    try {
      saved = selectedProvider
        ? await api.updateAgentProvider(selectedProvider.id, input)
        : await api.createAgentProvider(input);
      setForm((current) => ({ ...current, apiKey: "", clearApiKey: false }));
      const checked = await api.checkAgentProvider(saved.id);
      await refreshProviders(saved.id);
      if (checked.health?.state === "ready") {
        setNotice(t("agent.providers.checked"));
      } else {
        setLoadError(healthFeedback(checked));
      }
    } catch (error) {
      if (saved) await refreshProviders(saved.id);
      setLoadError(requestFeedback(error, saved ? t("agent.providers.checkError.failed") : t("agent.providers.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  // Deletes a provider by id; the first call arms the two-step confirmation
  // (deletePendingId), the second actually removes it. Works both from the
  // catalog list delete button and the form's footer button.
  const deleteProviderById = async (providerId: string) => {
    const target = providers.find((provider) => provider.id === providerId);
    if (!target || saving) return;
    if (deletePendingId !== providerId) {
      setDeletePendingId(providerId);
      return;
    }
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    try {
      await api.deleteAgentProvider(providerId);
      await refreshProviders();
      setNotice(t("agent.providers.deleted"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.providers.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (!open && !closing) return null;

  return (
    <div
      className={`agent-provider-settings-scrim${closing ? " closing" : ""}`}
      onMouseDown={(event) => {
        if (!saving && event.target === event.currentTarget) requestClose();
      }}
    >
      <aside ref={dialogRef} className={`agent-provider-settings${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={t("agent.providers.title")} tabIndex={-1}>
        <header className="agent-provider-settings-header">
          <div><span className="eyebrow">NAMI AGENT</span><span className="agent-provider-title-line"><h2>{pane === "mcp" ? t("agent.mcpServers.title") : t("agent.providers.title")}</h2><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={pane === "mcp" ? t("agent.mcpServers.description") : t("agent.providers.description")} data-tooltip={pane === "mcp" ? t("agent.mcpServers.description") : t("agent.providers.description")}><CircleHelp size={13} /></button></span></div>
          <div className="agent-provider-settings-actions">
            <div className="agent-provider-settings-tabs" role="tablist" aria-label={t("agent.providers.settings")} data-pane={pane}>
              <span className="agent-provider-settings-thumb" aria-hidden="true" />
              <button className={`agent-provider-settings-tab${pane === "providers" ? " active" : ""}`} type="button" role="tab" aria-selected={pane === "providers"} onClick={() => onPaneChange("providers")}><KeyRound size={13} /><span>{t("agent.providers.open")}</span></button>
              <button className={`agent-provider-settings-tab${pane === "mcp" ? " active" : ""}`} type="button" role="tab" aria-selected={pane === "mcp"} onClick={() => onPaneChange("mcp")}><Server size={13} /><span>{t("agent.mcpServers.open")}</span></button>
            </div>
            <button className="icon-button" type="button" data-dialog-initial-focus aria-label={t("agent.providers.close")} data-tooltip={t("agent.providers.close")} disabled={saving} onClick={requestClose}><X size={18} /></button>
          </div>
        </header>

        <div className="agent-provider-settings-body">
          {pane === "providers" ? (
            <>
              <section className="agent-provider-catalog" aria-label={t("agent.providers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.providers.available")}</span><button className="agent-provider-new" type="button" disabled={saving} onClick={() => selectProvider(null)}><Plus size={15} />{t("agent.providers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.providers.loading")}</div>}
            {!loading && !providers.length && <div className="agent-provider-empty"><Server size={18} /><strong>{t("agent.providers.empty")}</strong></div>}
            <div className="agent-provider-list">
              {providers.map((provider) => {
                const active = provider.id === selectedProviderId;
                const state = providerVisualState(provider);
                const pending = deletePendingId === provider.id;
                return (
                  <div key={provider.id} className={`agent-provider-list-row${pending ? " delete-pending" : ""}`}>
                    <button className={`agent-provider-list-item ${active ? "active" : ""}`} type="button" aria-pressed={active} disabled={saving} onClick={() => selectProvider(provider)}>
                      <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                      <span><strong>{provider.label}</strong><span className="agent-provider-list-meta">{provider.model && <em className="model" title={provider.model}>{provider.model}</em>}{provider.id === defaultProviderId && <em className="default">{t("agent.providers.status.default")}</em>}</span></span>
                      {provider.cloud ? <Cloud size={14} aria-label={t("agent.providers.status.cloud")} /> : <Server size={14} aria-label={t("agent.providers.status.local")} />}
                    </button>
                    <button className={`agent-provider-list-delete${pending ? " pending" : ""}`} type="button" disabled={saving} aria-label={pending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")} data-tooltip={pending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")} onClick={() => void deleteProviderById(provider.id)}>
                      {pending ? <Check size={14} /> : <Trash2 size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
            <div className="agent-provider-form-heading"><h3>{selectedProvider ? t("agent.providers.form.editTitle") : t("agent.providers.form.newTitle")}</h3>{selectedProvider && <span className={`agent-provider-form-status ${providerVisualState(selectedProvider)}`}>{providerVisualState(selectedProvider) === "verified" ? <Check size={14} /> : <CircleAlert size={14} />}{t(`agent.providers.status.${providerVisualState(selectedProvider)}`)}</span>}</div>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={saving} onClick={() => void refreshProviders(selectedProviderId)}>{t("agent.providers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}

            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.kind")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.providers.fields.kindHint")} data-tooltip={t("agent.providers.fields.kindHint")}><CircleHelp size={12} /></button></span><ThemedSelect id="agent-provider-kind" value={form.kind} onValueChange={(value) => updateKind(value as AgentProviderKind)} disabled={saving} aria-label={t("agent.providers.fields.kind")}><option value="openai-compatible">{t("agent.providers.kind.openaiCompatible")}</option><option value="ollama">{t("agent.providers.kind.ollama")}</option><option value="anthropic">{t("agent.providers.kind.anthropic")}</option><option value="gemini">{t("agent.providers.kind.gemini")}</option><option value="openai-responses">{t("agent.providers.kind.openaiResponses")}</option></ThemedSelect></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.label")}</strong></span><input value={form.label} maxLength={128} disabled={saving} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.endpoint")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t(kindMeta.endpointHintKey)} data-tooltip={t(kindMeta.endpointHintKey)}><CircleHelp size={12} /></button></span><input value={form.endpoint} placeholder={kindMeta.endpointSuggestion || t("agent.providers.fields.endpointPlaceholder")} disabled={saving} onChange={(event) => updateForm("endpoint", event.target.value)} autoComplete="url" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.model")}</strong></span><input value={form.model} placeholder={kindMeta.modelPlaceholder} maxLength={256} disabled={saving} onChange={(event) => updateForm("model", event.target.value)} autoComplete="off" spellCheck={false} /></label>
{embeddingCapable && <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.embeddingModel")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.providers.fields.embeddingModelHint")} data-tooltip={t("agent.providers.fields.embeddingModelHint")}><CircleHelp size={12} /></button></span><input value={form.embeddingModel} placeholder={kindMeta.embeddingModelPlaceholder} maxLength={256} disabled={saving} onChange={(event) => updateForm("embeddingModel", event.target.value)} autoComplete="off" spellCheck={false} /></label>}
<label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.providers.fields.timeout")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.providers.fields.timeoutHint")} data-tooltip={t("agent.providers.fields.timeoutHint")}><CircleHelp size={12} /></button></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={saving} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.providers.fields.apiKey")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")} data-tooltip={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")}><CircleHelp size={12} /></button></span><div className="agent-provider-secret"><input type={keyVisible ? "text" : "password"} value={form.apiKey} disabled={saving || form.clearApiKey} onChange={(event) => updateForm("apiKey", event.target.value)} placeholder={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyKeep") : t("agent.providers.fields.apiKeyPlaceholder")} autoComplete="new-password" spellCheck={false} /><button className="icon-button" type="button" disabled={saving || form.clearApiKey} aria-label={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} data-tooltip={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} onClick={() => setKeyVisible((visible) => !visible)}>{keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{selectedProvider?.apiKeyConfigured && <button className={`agent-provider-inline-toggle ${form.clearApiKey ? "active" : ""}`} type="button" role="switch" aria-checked={form.clearApiKey} disabled={saving || Boolean(form.apiKey)} onClick={() => updateForm("clearApiKey", !form.clearApiKey)}><span aria-hidden="true" /><span>{t("agent.providers.fields.clearApiKey")}</span></button>}</div>
            <button className={`agent-provider-toggle-row ${form.allowCloudMailContent ? "active" : ""}`} type="button" role="switch" aria-checked={form.allowCloudMailContent} disabled={saving || isOllama || isLocalEndpoint} onClick={() => updateForm("allowCloudMailContent", !form.allowCloudMailContent)}><span><strong>{t("agent.providers.cloud.title")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={isOllama || isLocalEndpoint ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")} data-tooltip={isOllama || isLocalEndpoint ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")}><CircleHelp size={12} /></button></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>
            <button className={`agent-provider-toggle-row ${form.makeDefault ? "active" : ""}`} type="button" role="switch" aria-checked={form.makeDefault} disabled={saving || isDefaultProvider} onClick={() => updateForm("makeDefault", !form.makeDefault)}><span><strong>{t("agent.providers.default.title")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={isDefaultProvider ? t("agent.providers.default.current") : t("agent.providers.default.description")} data-tooltip={isDefaultProvider ? t("agent.providers.default.current") : t("agent.providers.default.description")}><CircleHelp size={12} /></button></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions"><button className="primary-button" type="submit" disabled={saving || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{saving ? t("agent.providers.savingAndChecking") : t("agent.providers.save")}</button>{selectedProvider && <button className={`secondary-button danger-button ${deletePendingId === selectedProvider.id ? "agent-provider-delete-pending" : ""}`} type="button" disabled={saving} onClick={() => void deleteProviderById(selectedProvider.id)}><Trash2 size={15} />{deletePendingId === selectedProvider.id ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")}</button>}</div>
            {deletePendingId !== null && <p className="agent-provider-delete-note">{t("agent.providers.deletePrompt")}</p>}
          </form>
            </>
          ) : (
            <AgentMcpServerPane active={open} />
          )}
        </div>
      </aside>
    </div>
  );
}

/** Which settings pane is shown inside the shared provider/MCP dialog. */
type AgentSettingsPane = "providers" | "mcp";

type McpServerForm = {
  label: string;
  command: string;
  argsText: string;
  cwd: string;
  timeoutMs: string;
  enabled: boolean;
};

type EnvRow = {
  key: string;
  value: string;
};

function mcpServerFormFor(server: AgentMcpServerSummary | null): McpServerForm {
  if (!server) return { label: "", command: "", argsText: "", cwd: "", timeoutMs: "30000", enabled: true };
  return {
    label: server.label,
    command: server.command,
    argsText: server.args.join("\n"),
    cwd: server.cwd ?? "",
    timeoutMs: String(server.timeoutMs),
    enabled: server.enabled,
  };
}

function mcpEnvRowsFor(server: AgentMcpServerSummary | null): EnvRow[] {
  const rows = server ? server.envKeys.map((key) => ({ key, value: "" })) : [];
  rows.push({ key: "", value: "" });
  return rows;
}

function parseArgsText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function mcpServerVisualState(server: AgentMcpServerSummary): "checked" | "failed" | "enabled" | "disabled" {
  if (!server.enabled) return "disabled";
  if (server.lastError) return "failed";
  if (server.toolCount !== undefined) return "checked";
  return "enabled";
}

function AgentMcpServerPane({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<AgentMcpServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [form, setForm] = useState<McpServerForm>(() => mcpServerFormFor(null));
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => [{ key: "", value: "" }]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const selectedServerIdRef = useRef<string | null>(null);

  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? null;

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
  }, [selectedServerId]);

  const selectServer = useCallback((server: AgentMcpServerSummary | null) => {
    setSelectedServerId(server?.id ?? null);
    setForm(mcpServerFormFor(server));
    setEnvRows(mcpEnvRowsFor(server));
    setDeletePending(false);
    setNotice(null);
    setLoadError(null);
  }, []);

  const applyServerList = useCallback((snapshot: AgentMcpServerList, preferredServerId: string | null = null) => {
    setServers(snapshot.items);
    const selected = (preferredServerId ? snapshot.items.find((server) => server.id === preferredServerId) : undefined)
      ?? snapshot.items.find((server) => server.id === selectedServerIdRef.current)
      ?? snapshot.items[0]
      ?? null;
    setSelectedServerId(selected?.id ?? null);
    setForm(mcpServerFormFor(selected));
    setEnvRows(mcpEnvRowsFor(selected));
    setDeletePending(false);
  }, []);

  const refreshServers = useCallback(async (preferredServerId: string | null = null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await api.agentMcpServers();
      applyServerList(snapshot, preferredServerId);
      return snapshot;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.mcpServers.loadFailed"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyServerList, t]);

  useEffect(() => {
    if (!active) return;
    setSelectedServerId(null);
    setForm(mcpServerFormFor(null));
    setEnvRows([{ key: "", value: "" }]);
    setLoadError(null);
    setNotice(null);
    setDeletePending(false);
    void refreshServers();
  }, [active, refreshServers]);

  const updateForm = <Key extends keyof McpServerForm>(key: Key, value: McpServerForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
    setDeletePending(false);
  };

  const validationMessage = useMemo(() => {
    if (!form.label.trim()) return t("agent.mcpServers.validation.label");
    if (!form.command.trim()) return t("agent.mcpServers.validation.command");
    if (parseArgsText(form.argsText).some((arg) => arg.length > 1_024)) return t("agent.mcpServers.validation.args");
    const envPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const row of envRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (key.length > 256 || !envPattern.test(key) || row.value.length > 8_192) return t("agent.mcpServers.validation.env");
    }
    if (form.cwd.length > 2_048) return t("agent.mcpServers.validation.cwd");
    const timeoutMs = Number(form.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) return t("agent.mcpServers.validation.timeout");
    return null;
  }, [envRows, form.argsText, form.command, form.cwd, form.label, form.timeoutMs, t]);

  const requestFeedback = (error: unknown, fallback: string): string => {
    if (error instanceof ApiError) {
      if (error.code === "SERVER_CHANGED") return t("agent.mcpServers.checkError.changed");
      if (error.code === "local_service_unavailable") return t("agent.mcpServers.checkError.localService");
      return error.message || fallback;
    }
    return fallback;
  };

  const checkFeedback = (server: AgentMcpServerSummary): string => {
    switch (server.lastError?.code) {
      case "CONNECT_TIMEOUT":
      case "TIMEOUT":
        return t("agent.mcpServers.checkError.timeout");
      case "PROTOCOL_ERROR":
        return t("agent.mcpServers.checkError.protocol");
      case "CONNECTION_FAILED":
      case "CLOSED":
      case "NOT_CONNECTED":
        return t("agent.mcpServers.checkError.unavailable");
      default:
        return t("agent.mcpServers.checkError.failed");
    }
  };

  const buildInput = (): AgentMcpServerInput => {
    const existingEnvKeys = new Set(selectedServer?.envKeys ?? []);
    const env: Record<string, string> = {};
    const envRemove: string[] = [];
    const seenKeys = new Set<string>();
    for (const row of envRows) {
      const key = row.key.trim();
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (row.value.trim()) env[key] = row.value.trim();
    }
    for (const key of existingEnvKeys) {
      if (!seenKeys.has(key)) envRemove.push(key);
    }
    return {
      label: form.label.trim(),
      command: form.command.trim(),
      args: parseArgsText(form.argsText),
      env,
      ...(envRemove.length ? { envRemove } : {}),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      timeoutMs: Number(form.timeoutMs),
      enabled: form.enabled,
    };
  };

  const saveServer = async () => {
    if (saving || checking || validationMessage) return;
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    let saved: AgentMcpServerSummary | undefined;
    try {
      saved = selectedServer
        ? await api.updateAgentMcpServer(selectedServer.id, buildInput())
        : await api.createAgentMcpServer(buildInput());
      const checked = await api.checkAgentMcpServer(saved.id);
      await refreshServers(saved.id);
      if (checked.lastError) {
        setLoadError(checkFeedback(checked));
      } else {
        setNotice(t("agent.mcpServers.checked"));
      }
    } catch (error) {
      if (saved) await refreshServers(saved.id);
      setLoadError(requestFeedback(error, saved ? t("agent.mcpServers.checkFailed") : t("agent.mcpServers.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const checkServer = async () => {
    if (!selectedServer || saving || checking) return;
    setChecking(true);
    setLoadError(null);
    setNotice(null);
    try {
      const checked = await api.checkAgentMcpServer(selectedServer.id);
      await refreshServers(selectedServer.id);
      if (checked.lastError) {
        setLoadError(checkFeedback(checked));
      } else {
        setNotice(t("agent.mcpServers.checked"));
      }
    } catch (error) {
      setLoadError(requestFeedback(error, t("agent.mcpServers.checkFailed")));
    } finally {
      setChecking(false);
    }
  };

  const deleteServer = async () => {
    if (!selectedServer || saving || checking) return;
    if (!deletePending) {
      setDeletePending(true);
      return;
    }
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    try {
      await api.deleteAgentMcpServer(selectedServer.id);
      await refreshServers();
      setNotice(t("agent.mcpServers.deleted"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.mcpServers.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  const updateEnvRow = (index: number, patch: Partial<EnvRow>) => {
    setEnvRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
    setNotice(null);
    setDeletePending(false);
  };

  const removeEnvRow = (index: number) => {
    setEnvRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
    setNotice(null);
    setDeletePending(false);
  };

  if (!active) return null;

  const busy = saving || checking;
  const selectedState = selectedServer ? mcpServerVisualState(selectedServer) : "enabled";
  const selectedStateLabel = selectedServer ? t(`agent.mcpServers.status.${selectedState}`) : "";

  return (
    <>
      <section className="agent-provider-catalog" aria-label={t("agent.mcpServers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.mcpServers.available")}</span><button className="agent-provider-new" type="button" disabled={busy} onClick={() => selectServer(null)}><Plus size={15} />{t("agent.mcpServers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.mcpServers.loading")}</div>}
            {!loading && !servers.length && <div className="agent-provider-empty"><Server size={18} /><strong>{t("agent.mcpServers.empty")}</strong></div>}
            <div className="agent-provider-list">
              {servers.map((server) => {
                const isSelected = server.id === selectedServerId;
                const state = mcpServerVisualState(server);
                return (
                  <button key={server.id} className={`agent-provider-list-item ${isSelected ? "active" : ""}`} type="button" aria-pressed={isSelected} disabled={busy} title={server.command} onClick={() => selectServer(server)}>
                    <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                    <span>
                      <strong>{server.label}</strong>
                      <span className="agent-provider-list-meta">{server.toolCount !== undefined && <em className="tools">{t("agent.mcpServers.status.tools", { count: server.toolCount })}</em>}</span>
                    </span>
                    <Server size={14} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveServer(); }}>
            <div className="agent-provider-form-heading"><h3>{selectedServer ? t("agent.mcpServers.form.editTitle") : t("agent.mcpServers.form.newTitle")}</h3>{selectedServer && <span className={`agent-provider-form-status ${selectedState}`}>{selectedState === "checked" ? <Check size={14} /> : <CircleAlert size={14} />}{selectedStateLabel}</span>}</div>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={busy} onClick={() => void refreshServers(selectedServerId)}>{t("agent.mcpServers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}

            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.label")}</strong></span><input value={form.label} maxLength={128} disabled={busy} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.command")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.commandHint")} data-tooltip={t("agent.mcpServers.fields.commandHint")}><CircleHelp size={12} /></button></span><input value={form.command} placeholder={t("agent.mcpServers.fields.commandPlaceholder")} maxLength={1024} disabled={busy} onChange={(event) => updateForm("command", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.args")}</strong></span><textarea className="agent-mcp-args-input" value={form.argsText} placeholder={t("agent.mcpServers.fields.argsPlaceholder")} rows={3} disabled={busy} onChange={(event) => updateForm("argsText", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.env")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.envHint")} data-tooltip={t("agent.mcpServers.fields.envHint")}><CircleHelp size={12} /></button></span>
              <div className="agent-mcp-env-editor">
                {envRows.map((row, index) => (
                  <div className="agent-mcp-env-row" key={`${index}:${row.key || ""}:${row.value || ""}`}>
                    <input value={row.key} placeholder={t("agent.mcpServers.fields.envKeyPlaceholder")} maxLength={256} disabled={busy} onChange={(event) => updateEnvRow(index, { key: event.target.value })} autoComplete="off" spellCheck={false} />
                    <input value={row.value} placeholder={selectedServer?.envKeys.includes(row.key.trim()) ? t("agent.mcpServers.fields.envSaved") : t("agent.mcpServers.fields.envValuePlaceholder")} maxLength={8192} disabled={busy} onChange={(event) => updateEnvRow(index, { value: event.target.value })} autoComplete="off" spellCheck={false} />
                    <button className="icon-button" type="button" disabled={busy} aria-label={t("agent.mcpServers.delete")} data-tooltip={t("agent.mcpServers.delete")} onClick={() => removeEnvRow(index)}><X size={14} /></button>
                  </div>
                ))}
                <button className="agent-mcp-add-env" type="button" disabled={busy} onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}><Plus size={13} />{t("agent.mcpServers.fields.addEnv")}</button>
              </div>
            </div>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.cwd")}</strong></span><input value={form.cwd} maxLength={2048} disabled={busy} onChange={(event) => updateForm("cwd", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.mcpServers.fields.timeout")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.timeoutHint")} data-tooltip={t("agent.mcpServers.fields.timeoutHint")}><CircleHelp size={12} /></button></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={busy} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <button className={`agent-provider-toggle-row ${form.enabled ? "active" : ""}`} type="button" role="switch" aria-checked={form.enabled} disabled={busy} onClick={() => updateForm("enabled", !form.enabled)}><span><strong>{t("agent.mcpServers.fields.enabled")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.enabledHint")} data-tooltip={t("agent.mcpServers.fields.enabledHint")}><CircleHelp size={12} /></button></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions">
              <button className="primary-button" type="submit" disabled={busy || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Server size={15} />}{saving ? t("agent.mcpServers.savingAndChecking") : t("agent.mcpServers.save")}</button>
              {selectedServer && <button className="secondary-button" type="button" disabled={busy || Boolean(validationMessage)} onClick={() => void checkServer()}>{checking ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{checking ? t("agent.mcpServers.checking") : t("agent.mcpServers.check")}</button>}
              {selectedServer && <button className={`secondary-button danger-button ${deletePending ? "agent-provider-delete-pending" : ""}`} type="button" disabled={busy} onClick={() => void deleteServer()}><Trash2 size={15} />{deletePending ? t("agent.mcpServers.deleteConfirm") : t("agent.mcpServers.delete")}</button>}
            </div>
            {deletePending && <p className="agent-provider-delete-note">{t("agent.mcpServers.deletePrompt")}</p>}
          </form>
    </>
  );
}

export default function AgentWorkspace({ accounts, currentMessage, onClose, onOpenMessage, restoreFocusRef, demoMode = false, providerSettingsRequestId = 0, preloadedBootstrap, agentAccessLevel = "send-confirmed", onAgentAccessLevelChange }: AgentWorkspaceProps) {
  const { locale, t } = useI18n();
  const [bootstrap, setBootstrap] = useState<AgentBootstrap | null>(null);
  const [conversations, setConversations] = useState<AgentBootstrap["conversations"]>([]);
  const [active, setActive] = useState<AgentConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  /** Set when the user dismisses the slash menu (Esc) or completes a command. */
  const [slashDismissed, setSlashDismissed] = useState(false);
  /** Memory summaries the agent suggested saving; each needs a save or dismiss. */
  const [pendingMemorySuggestions, setPendingMemorySuggestions] = useState<string[]>([]);
  const [mode, setMode] = useState<AgentMode>("agent");
  const [providerId, setProviderId] = useState("");
  const [scopeMode, setScopeMode] = useState<AgentScopeMode>(currentMessage ? "current_message" : "all_accounts");
  const [streaming, setStreaming] = useState(false);
  /** Live provider status text shown in the in-flight assistant's thinking line. */
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  /**
   * A turn that outlived the panel is being picked up: the fold-in poll is
   * watching this conversation because its newest message is a user message
   * (or a server streaming snapshot) with no local session attached. While set,
   * the composer shows a stop affordance backed by cancelAgentRun — the usual
   * in-session interrupt cannot reach a run without a local controller.
   */
  const [ghostConversationId, setGhostConversationId] = useState<string | null>(null);
  /**
   * A conversation whose shell is already on screen (optimistic switch) while
   * its record is still being fetched. The transcript renders a skeleton until
   * the load lands; the composer is gated so nothing can be sent against the
   * shell.
   */
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  /** Conversations awaiting a destructive-delete confirmation dialog (ids; one for a single delete, several for a bulk delete). */
  const [deleteConfirm, setDeleteConfirm] = useState<string[] | null>(null);
  /** Holds a full-access request that still needs the user's explicit warning acknowledgment. */
  const [pendingAccessLevel, setPendingAccessLevel] = useState<AgentAccessLevel | null>(null);
  /** Whether the composer permission picker popover is open. */
  const [permissionOpen, setPermissionOpen] = useState(false);
  /** Anchors the permission popover so an outside click closes it. */
  const permissionRef = useRef<HTMLDivElement>(null);
  /** Whether the composer model picker popover is open. */
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  /** Anchors the model picker popover so an outside click closes it. */
  const modelPickerRef = useRef<HTMLDivElement>(null);
  /** Per-conversation model overrides chosen in this session (conversationId → providerId). */
  const [conversationProviders, setConversationProviders] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem(CONVERSATION_PROVIDERS_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  });
  const conversationProvidersRef = useRef(conversationProviders);
  conversationProvidersRef.current = conversationProviders;
  // Persist per-conversation model choices so they survive restarts. A bare
  // { } entry is removed again to keep storage tidy.
  useEffect(() => {
    try {
      const entries = Object.entries(conversationProviders).filter(([, providerId]) => typeof providerId === "string" && providerId.length > 0);
      if (entries.length === 0) {
        window.localStorage.removeItem(CONVERSATION_PROVIDERS_KEY);
      } else {
        window.localStorage.setItem(CONVERSATION_PROVIDERS_KEY, JSON.stringify(Object.fromEntries(entries)));
      }
    } catch {
      // Storage may be unavailable (private mode); the choice simply stays in memory.
    }
  }, [conversationProviders]);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  // The provider and MCP settings share one dialog; switching panes swaps the
  // body in place so the dialog never unmounts (no open/close flicker).
  const [agentSettingsPane, setAgentSettingsPane] = useState<AgentSettingsPane | null>(null);
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  const [confirmationErrors, setConfirmationErrors] = useState<Record<string, string>>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<ProcessedFile[]>([]);
  const [processingFileName, setProcessingFileName] = useState<string | null>(null);
  const [citationsExpanded, setCitationsExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  // Right-click menu on the conversation sidebar: a conversation row (delete /
  // multi-select / rename / copy) or the list blank area (new conversation).
  const [sidebarMenu, setSidebarMenu] = useState<{ x: number; y: number; conversationId: string | null } | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
  const [multiDeleteBusy, setMultiDeleteBusy] = useState(false);
  const [quoteContext, setQuoteContext] = useState<string | null>(null);
  // Content coordinates of each user message, used only as the jump target
  // when a scrubber bar is clicked. Bar layout itself is a fixed-interval
  // group (see SCRUBBER_* constants), independent of these positions.
  const [userMarkerPositions, setUserMarkerPositions] = useState<number[]>([]);
  const [hoveredUserIndex, setHoveredUserIndex] = useState<number | null>(null);
  const userMessageElsRef = useRef<Map<string, HTMLElement>>(new Map());
  // Preview bubble visibility is delayed: the mountain highlight follows the
  // cursor immediately, but the preview appears only after the cursor rests on
  // a bar for a moment (see SCRUBBER_PREVIEW_DELAY_MS). The timer is kept in a
  // ref so quick passes reset it without re-rendering.
  const [showScrubberPreview, setShowScrubberPreview] = useState(false);
  const scrubberPreviewTimerRef = useRef<number | undefined>(undefined);
  // Viewport offset (px) of the bar group inside the track. When the group
  // fits it is centred; once it overflows it is bottom-anchored (newest
  // visible). Hovering the edge zones auto-scrolls this offset — the BARS
  // scroll, never the transcript content. Mirrored in a ref so the rAF loop
  // and mouse-move handler can read the latest value without re-binding.
  const [scrubberViewport, setScrubberViewport] = useState<number | null>(null);
  const scrubberViewportRef = useRef<number | null>(null);
  const scrubberTrackRef = useRef<HTMLDivElement>(null);
  // Track height drives the edge blur of bars; kept in state so the blur
  // recalculates on resize without reading the DOM during render.
  const [scrubberTrackHeight, setScrubberTrackHeight] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Conversations with a live run streaming in the background (not the one on
  // screen); drives the sidebar spinner so a run the user left keeps being
  // visible elsewhere.
  const [backgroundRunIds, setBackgroundRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const syncBackgroundRuns = useCallback(() => {
    const ids = new Set<string>();
    sessionStreamsRef.current.forEach((session, id) => {
      // A run that turned terminal (done/aborted) is no longer "working": it
      // either finished or was stopped, so its spinner goes out immediately
      // even though the slot is only cleaned up once the SSE finally closes.
      if (activeIdRef.current !== id && !session.done && !session.controller.signal.aborted) ids.add(id);
    });
    setBackgroundRunIds((current) => {
      if (current.size === ids.size && [...current].every((id) => ids.has(id))) return current;
      return ids;
    });
  }, []);
  // Clearing a memory suggestion (saved or dismissed) from the UI must also
  // drop it from the backing session: otherwise re-entering the conversation
  // replays it as a fresh undecided chip and the same memory can be saved twice.
  const consumeAgentSuggestion = useCallback((summary: string) => {
    const session = sessionStreamsRef.current.get(activeIdRef.current ?? "");
    if (session) session.suggestions = session.suggestions.filter((item) => item !== summary);
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const sidebarMenuRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const providerSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const accessConfirmRef = useRef<HTMLElement>(null);
  // Latest transcript mirror for stable callbacks passed to memoized message
  // rows. Reading through a ref keeps the row props referentially stable so an
  // unrelated re-render (scroll, scrubber hover, other rows streaming) never
  // invalidates a row that has not changed.
  const activeMessagesRef = useRef<AgentMessage[] | undefined>(undefined);
  useEffect(() => {
    activeMessagesRef.current = active?.messages;
  }, [active?.messages]);
  // Mirror of the active conversation id for callbacks that must judge "am I
  // the conversation on screen" without re-binding on every render (stream
  // callbacks, teardown, replay). Kept in sync with the `active` state.
  const activeIdRef = useRef<string | null>(null);
  // Monotonic token for conversation-selection races: a stale fetch abandoned
  // after a newer selection bumps the counter.
  const selectionTokenRef = useRef(0);
  // Serialises concurrent conversation creation so a double-send out of an
  // empty (or scope-switched) workspace yields a single record, not one orphan
  // per concurrent send.
  const creatingConversationRef = useRef<Promise<AgentConversation> | null>(null);
  // Failures of background runs (the user left the conversation while it ran).
  // The server persists most failure turns itself, but requests rejected before
  // any record is written (scope/slash validation, transport failure, an
  // exhausted CONFLICT retry) leave the conversation with neither a row nor an
  // error — re-entry would silently show a bare user message. Keyed by
  // conversation, consumed (and cleared) once re-surfaced in the view.
  const backgroundErrorRef = useRef(new Map<string, { code: string; message: string; retryable?: boolean }>());
  useEffect(() => {
    activeIdRef.current = active?.id ?? null;
  }, [active?.id]);
  useEffect(() => {
    const streamsRef = sessionStreamsRef;
    return () => {
      // Closing the panel is a "leave", not a "cancel". Drop the local stream
      // (the fetch rejection aborts the SSE, which on the server only stops
      // event delivery — the run keeps draining and persists the completed
      // turn, per the /messages route contract). We must NOT call
      // cancelAgentRun here: that aborts the server run and its finally skips
      // persisting the assistant row, so reopening shows just the orphaned
      // user message with no reply and no tool calls. The completed reply is
      // instead picked up on reopen by the polling fold-in effect.
      for (const session of streamsRef.current.values()) {
        session.controller.abort();
      }
    };
  }, []);
  const registerUserMessageEl = useCallback((messageId: string, node: HTMLElement | null) => {
    if (node) userMessageElsRef.current.set(messageId, node);
    else userMessageElsRef.current.delete(messageId);
  }, []);
  const retryLastUserTurn = useCallback(() => {
    const target = activeMessagesRef.current?.slice().reverse().find((item) => item.role === "user");
    setComposer(target?.content ?? "");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  useDialogFocus(true, workspaceRef, { restoreFocusRef, suspended: agentSettingsPane !== null || Boolean(pendingAccessLevel) });
  useDialogFocus(Boolean(pendingAccessLevel), accessConfirmRef, { restoreFocusRef: workspaceRef });

  const scope = useMemo(() => agentScopeFor(scopeMode, currentMessage, accounts), [accounts, currentMessage, scopeMode]);
  const providers = useMemo(() => bootstrap?.providers ?? [], [bootstrap]);
  const configuredProviders = useMemo(() => providers.filter((provider) => provider.configured), [providers]);
  const selectedProvider = configuredProviders.find((provider) => provider.id === providerId)
    ?? providers.find((provider) => provider.id === bootstrap?.defaultProviderId)
    ?? configuredProviders[0];
  // Sending still requires a ready provider; the composer may show an
  // unconfigured default model but must not claim it can send with it.
  const hasConfiguredProvider = Boolean(selectedProvider && selectedProvider.configured);
  const filteredConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase(locale);
    if (!query) return conversations;
    return conversations.filter((conversation) => `${conversation.title} ${conversation.preview}`.toLocaleLowerCase(locale).includes(query));
  }, [conversationSearch, conversations, locale]);

  const refreshConversations = useCallback(async (query = "") => {
    if (demoMode) {
      setConversations([]);
      return;
    }
    const response = await api.agentConversations(query ? new URLSearchParams({ query }).toString() : "");
    setConversations(response.items);
  }, [demoMode]);

  const applyProviderList = useCallback((snapshot: AgentProviderList) => {
    setBootstrap((current) => current ? {
      ...current,
      providers: snapshot.items,
      defaultProviderId: snapshot.defaultProviderId,
      configured: snapshot.items.some((provider) => provider.configured),
    } : current);
    setProviderId(configuredProviderId(snapshot.items, snapshot.defaultProviderId));
  }, []);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    if (demoMode) {
      // Demo mode still renders the full provider + permission UI, so the
      // picker and the permission accordion are visible. The provider is a
      // local (non-cloud) one; the composer itself stays disabled.
      const demoProvider: AgentProviderSummary = {
        id: "demo-ollama",
        label: "Ollama",
        kind: "ollama",
        endpoint: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        embeddingModel: "nomic-embed-text",
        timeoutMs: 120000,
        apiKeyConfigured: true,
        configured: true,
        cloud: false,
        cloudContentConsent: true,
        streaming: true,
        vision: false,
      };
      setBootstrap({
        enabled: true,
        configured: true,
        providers: [demoProvider],
        defaultProviderId: "demo-ollama",
        conversations: [],
      });
      const demoConversation = createDemoConversation();
      setActive(demoConversation);
      setConversations([{ id: demoConversation.id, title: demoConversation.title, preview: demoConversation.preview, updatedAt: demoConversation.updatedAt }]);
      setProviderId("demo-ollama");
      setLoading(false);
      return;
    }
    try {
      // Use preloaded bootstrap data when available (fetched during splash).
      const value = preloadedBootstrap ?? await api.agentBootstrap();
      setBootstrap(value);
      setConversations(value.conversations);
      setProviderId((current) => {
        const currentProvider = value.providers.find((provider) => provider.id === current && provider.configured);
        return currentProvider?.id ?? configuredProviderId(value.providers, value.defaultProviderId);
      });
      // Show the UI immediately — load the last active conversation (or the
      // newest one) in the background so a large transcript never blocks the
      // history list.
      setLoading(false);
      const lastActiveId = readLastActiveConversationId();
      const initialTarget = value.conversations.some((item) => item.id === lastActiveId)
        ? lastActiveId!
        : value.conversations[0]?.id;
      if (initialTarget) {
        try {
          const conversation = await api.agentConversation(initialTarget);
          setActive(applyRevokedMarks(purgeStaleErrors(conversation)));
          // Resolve the conversation's model exactly like switching to it: the
          // user's per-conversation choice (persisted across restarts) wins,
          // then the provider recorded on the conversation, then the default.
          const localProvider = conversationProvidersRef.current[initialTarget];
          setProviderId(localProvider && value.providers.some((provider) => provider.id === localProvider && provider.configured)
            ? localProvider
            : conversation.providerId && value.providers.some((provider) => provider.id === conversation.providerId && provider.configured)
              ? conversation.providerId
              : configuredProviderId(value.providers, value.defaultProviderId));
          setScopeMode(conversation.scope.mode);
        } catch {
          // Background load of the first conversation failed — user can retry by clicking it.
        }
      }
      setLoading(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.load"));
    } finally {
      setLoading(false);
    }
  }, [demoMode, preloadedBootstrap, t]);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);

  // Close the permission and model pickers when the user clicks anywhere
  // outside them or presses Escape.
  useEffect(() => {
    if (!permissionOpen && !modelPickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (permissionRef.current && !permissionRef.current.contains(event.target as Node)) {
        setPermissionOpen(false);
      }
      if (modelPickerRef.current && !modelPickerRef.current.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPermissionOpen(false);
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [permissionOpen, modelPickerOpen]);
  useEffect(() => {
    if (demoMode || providerSettingsRequestId === 0) return;
    setAgentSettingsPane("providers");
  }, [demoMode, providerSettingsRequestId]);
  // Auto-scroll the transcript as the assistant streams new tokens. We track a
  // "stick to bottom" ref: while true, every content change scrolls to the
  // bottom instantly (instant scroll is smoother than smooth-scroll for fast
  // token streams). When the user scrolls up manually, we stop following; when
  // they scroll back to the bottom (or click the scroll-to-bottom button), we
  // resume. Using a ref avoids re-renders on every scroll tick.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages, streaming]);
  // Auto-resize the composer textarea to fit its content up to max-height (160px).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, [composer]);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollToBottom(distanceFromBottom > 120);
      stickToBottomRef.current = distanceFromBottom < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);
  // Scrubber: re-measure user-message anchors whenever the set of user
  // messages changes (streamed assistant tokens never move earlier messages,
  // so measuring on message-identity changes keeps this cheap).
  const userMessages = useMemo(
    () => active?.messages.filter((message) => message.role === "user" && !message.revoked) ?? [],
    [active?.messages],
  );
  // Index of the newest user turn. Rows before it are superseded: the user has
  // moved on, so their failure warnings fold up instead of staying expanded.
  const lastUserMessageIndex = useMemo(() => {
    const messages = active?.messages;
    if (!messages) return -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]!.role === "user") return index;
    }
    return -1;
  }, [active?.messages]);
  const userMessageIdsKey = userMessages.map((message) => message.id).join("|");
  useEffect(() => {
    const ids = userMessageIdsKey ? userMessageIdsKey.split("|") : [];
    const el = transcriptRef.current;
    if (!el || ids.length === 0) {
      setUserMarkerPositions([]);
      return;
    }
    const containerRect = el.getBoundingClientRect();
    setUserMarkerPositions(ids.map((id) => {
      const node = userMessageElsRef.current.get(id);
      if (!node) return 0;
      // Content coordinate: viewport offset plus the current scroll position,
      // so bars stay aligned regardless of where the transcript is scrolled.
      return node.getBoundingClientRect().top - containerRect.top + el.scrollTop;
    }));
  }, [userMessageIdsKey]);
  // Initialise the scrubber viewport whenever the bar group changes or the
  // track resizes: centre the group when it fits, bottom-anchor it (newest
  // visible) once it overflows. Kept in sync with the ref the handlers read.
  useEffect(() => {
    const track = scrubberTrackRef.current;
    if (!track || userMessages.length === 0) {
      scrubberViewportRef.current = null;
      setScrubberViewport(null);
      return;
    }
    const totalHeight = (userMessages.length - 1) * SCRUBBER_BAR_GAP;
    const sync = () => {
      const initial = Math.min((track.clientHeight - totalHeight) / 2, track.clientHeight - totalHeight);
      scrubberViewportRef.current = initial;
      setScrubberViewport(initial);
      setScrubberTrackHeight(track.clientHeight);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [userMessageIdsKey, userMessages.length]);
  const handleScrubberMove = useCallback((event: React.MouseEvent) => {
    const el = transcriptRef.current;
    if (!el || userMessages.length === 0) return;
    const track = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - track.top;
    const count = userMessages.length;
    const totalHeight = (count - 1) * SCRUBBER_BAR_GAP;
    // Initial viewport: centre the group when it fits; anchor it to the
    // bottom (newest visible) once it overflows the track.
    if (scrubberViewportRef.current === null) {
      const initial = Math.min((track.height - totalHeight) / 2, track.height - totalHeight);
      scrubberViewportRef.current = initial;
      setScrubberViewport(initial);
    }
    const viewport = scrubberViewportRef.current;
    // The mountain peak follows the cursor in real time: pick the bar whose
    // rendered centre is closest to the pointer within the fixed-interval
    // layout at the current viewport offset.
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let index = 0; index < count; index += 1) {
      const distance = Math.abs(viewport + index * SCRUBBER_BAR_GAP - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    }
    // Restart the preview delay only when the cursor moves onto a different
    // bar; staying on the same bar keeps the pending timer so the bubble
    // appears after resting for a moment.
    if (nearest !== hoveredUserIndex) {
      window.clearTimeout(scrubberPreviewTimerRef.current);
      setShowScrubberPreview(false);
      setHoveredUserIndex(nearest);
      scrubberPreviewTimerRef.current = window.setTimeout(() => setShowScrubberPreview(true), SCRUBBER_PREVIEW_DELAY_MS);
    }
  }, [hoveredUserIndex, userMessages.length]);
  // The wheel replaces the old edge-zone auto-scroll: it moves the BAR GROUP
  // (never the transcript content) by the scroll delta so the user controls
  // the speed directly. Only active once the group overflows the track.
  const handleScrubberWheel = useCallback((event: React.WheelEvent) => {
    if (userMessages.length === 0) return;
    const track = event.currentTarget.getBoundingClientRect();
    const count = userMessages.length;
    const totalHeight = (count - 1) * SCRUBBER_BAR_GAP;
    if (totalHeight <= track.height) return;
    event.preventDefault();
    // Initial viewport: centre the group when it fits; anchor it to the
    // bottom (newest visible) once it overflows the track.
    if (scrubberViewportRef.current === null) {
      const initial = Math.min((track.height - totalHeight) / 2, track.height - totalHeight);
      scrubberViewportRef.current = initial;
      setScrubberViewport(initial);
    }
    const maxOffset = totalHeight - track.height;
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const current = scrubberViewportRef.current;
    if (current === null) return;
    // Scrolling up (deltaY < 0) reveals older messages; scrolling down moves
    // toward the newest, matching the natural wheel direction.
    const next = Math.min(0, Math.max(-maxOffset, current - delta));
    if (next === current) return;
    scrubberViewportRef.current = next;
    setScrubberViewport(next);
  }, [userMessages.length]);
  const jumpToUserMessage = useCallback((index: number) => {
    const el = transcriptRef.current;
    const position = userMarkerPositions[index];
    if (!el || position === undefined) return;
    stickToBottomRef.current = false;
    el.scrollTo({ top: Math.max(0, position - 16), behavior: "smooth" });
  }, [userMarkerPositions]);
  // While hovering the scrubber every bar grows; the nearest one is longest
  // and neighbours fall off towards the base, forming a mountain around the
  // cursor. All bars are longer than the resting state once hovered.
  const scrubberBarWidth = (index: number, hovered: number | null): number => {
    if (hovered === null) return 5;
    return Math.max(9, 26 - Math.abs(index - hovered) * 6);
  };
  const hoveredUserMessage = hoveredUserIndex !== null ? userMessages[hoveredUserIndex] : undefined;
  const hoveredUserPreview = hoveredUserMessage
    ? truncateForPreview(
      hoveredUserMessage.content || hoveredUserMessage.attachments?.map((attachment) => attachment.name).join(", ") || "",
      120,
    )
    : "";
  // Custom context menu: show "Copy" and "Follow up" when text is selected in transcript.
  const handleTranscriptContextMenu = useCallback((event: React.MouseEvent) => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, text });
  }, []);
  // Sidebar right-click: a conversation row menu (delete / multi-select /
  // rename / copy) or the blank list area (new conversation).
  const openConversationMenu = useCallback((event: React.MouseEvent, conversationId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setSidebarMenu({ x: event.clientX, y: event.clientY, conversationId });
  }, []);
  // Menu items fade the menu out before acting, so the action's own transition
  // (selection bar expanding, checkboxes fading in) follows the dismissal
  // instead of fighting it in the same frame.
  const runMenuAction = useCallback((action: () => void) => {
    sidebarMenuRef.current?.classList.add("closing");
    window.setTimeout(() => {
      setSidebarMenu(null);
      action();
    }, 90);
  }, []);
  const toggleConversationSelected = useCallback((id: string) => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedConversationIds(new Set());
  }, []);
  const enterSelectionMode = useCallback((id: string) => {
    setSelectionMode(true);
    setSelectedConversationIds(new Set([id]));
  }, []);
  const serializeConversationForExport = useCallback((conversation: AgentConversation, format: "markdown" | "json") => {
    const messages = conversation.messages.filter((message) => message.role === "user" || message.role === "assistant");
    if (format === "json") {
      return `${JSON.stringify({
        version: 1,
        title: conversation.title,
        provider: conversation.providerId,
        created_at: messages[0]?.createdAt ?? conversation.updatedAt,
        updated_at: conversation.updatedAt,
        messages: messages.map((message) => ({ role: message.role, content: message.content, created_at: message.createdAt })),
      }, null, 2)}\n`;
    }
    const lines: string[] = [`# ${conversation.title}`, ""];
    if (conversation.providerId) lines.push(`provider: ${conversation.providerId}`, "");
    for (const message of messages) {
      lines.push(`## ${message.role === "user" ? t("agent.message.userPrefix") : t("agent.message.assistantPrefix")}`, "", message.content, "");
    }
    return lines.join("\n");
  }, [t]);
  const downloadConversation = useCallback(async (id: string, format: "markdown" | "json") => {
    try {
      const conversation = await api.agentConversation(id);
      const content = serializeConversationForExport(conversation, format);
      const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      const safeTitle = conversation.title.replace(/[^\p{L}\p{N} _\-()（）]/gu, "").trim().slice(0, 48) || "conversation";
      link.href = url;
      link.download = `${safeTitle}-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "json" : "md"}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.exportConversation"));
    }
  }, [serializeConversationForExport, t]);
  /**
   * Bulk delete: server-side first for every target, then tear down the local
   * session/error bookkeeping for the ones whose delete succeeded (a failed
   * delete must not kill a nearly-finished reply). Failures are surfaced via
   * loadError but do not abort the rest of the batch.
   */
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const menu = contextMenuRef.current;
    const items = menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : [];
    // Move focus into the menu so keyboard users can act without a mouse.
    items[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = items[(current + delta + items.length) % items.length];
        next?.focus();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        // The focused menuitem activates natively; only stop other handlers.
        e.stopPropagation();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("resize", close); window.removeEventListener("keydown", onKey); };
  }, [contextMenu]);

  // Sidebar menu: same dismissal/keyboard pattern as the transcript menu.
  useEffect(() => {
    if (!sidebarMenu) return;
    const close = () => setSidebarMenu(null);
    const menu = sidebarMenuRef.current;
    const items = menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : [];
    items[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = items[(current + delta + items.length) % items.length];
        next?.focus();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        // The focused menuitem activates natively; only stop other handlers.
        e.stopPropagation();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("resize", close); window.removeEventListener("keydown", onKey); };
  }, [sidebarMenu]);

  // Escape exits multi-select mode without deleting anything.
  useEffect(() => {
    if (!selectionMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitSelectionMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitSelectionMode, selectionMode]);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (!isSupportedFile(file)) {
        setProcessingFileName(null);
        continue;
      }
      setProcessingFileName(file.name);
      try {
        const processed = await processFile(file);
        // Upload the file as an outbound mail attachment so the Agent can
        // attach it to drafts/messages (bound to the first scoped account).
        // Uploading is best-effort: the extracted text remains usable even if
        // the attachment upload fails or the scope has no account. Demo mode
        // skips the upload entirely (no backend) and keeps the extracted text.
        const accountId = demoMode ? undefined : scope.accountIds[0];
        setAttachedFiles((prev) => [...prev, { ...processed, mailUploadState: accountId ? "uploading" : undefined }]);
        if (accountId) {
          try {
            const attachment = await api.uploadOutboundAttachment(accountId, file);
            setAttachedFiles((prev) => prev.map((item) =>
              item.name === processed.name && item.size === processed.size && item.mailUploadState === "uploading"
                ? { ...item, mailToken: attachment.token, mailAccountId: accountId, mailUploadState: "ready" }
                : item));
          } catch {
            setAttachedFiles((prev) => prev.map((item) =>
              item.name === processed.name && item.size === processed.size && item.mailUploadState === "uploading"
                ? { ...item, mailUploadState: "failed" }
                : item));
          }
        }
      } catch {
        setProcessingFileName(null);
      }
    }
    setProcessingFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [demoMode, scope.accountIds]);

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const openAttachmentFolder = useCallback((path?: string) => {
    if (!path) return;
    void desktopBridge()?.showItemInFolder?.(path);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => window.clearTimeout(scrubberPreviewTimerRef.current), []);
  // Remember which conversation the panel was on so reopening lands on it
  // (closing the panel does not cancel a running turn; the user returns to
  // that conversation to see the completed reply).
  useEffect(() => {
    if (!active?.id) return;
    try {
      window.localStorage.setItem(LAST_ACTIVE_CONVERSATION_KEY, active.id);
    } catch {
      // Storage unavailable — the fallback to the newest conversation applies.
    }
  }, [active?.id]);
  // A pickup the user explicitly abandoned (stop) is recorded so the poll can
  // never re-arm for the same last message: the server run was cancelled and
  // can never complete. Recording the message id keeps a fresh turn (a new
  // last message) on an independent poll.
  const abandonedPickupRef = useRef<{ conversationId: string; lastMessageId: string } | null>(null);
  // A conversation whose newest turn has no assistant reply yet may still be
  // finishing on the server (closing the panel does not cancel the run). Poll
  // for the completed reply and fold it into the transcript. The polling
  // stops as soon as the local transcript moves on (new send, conversation
  // switch) or the attempt budget runs out.
  // The effect keys on the conversation id and the last message id instead of
  // the `active` object: a streaming snapshot fold-in must not tear the poll
  // down and re-arm it (which bypasses the 2s interval).
  const pollLastMessageId = active?.messages[active.messages.length - 1]?.id;
  useEffect(() => {
    // Poll while the newest turn is unfinished: the last message is either the
    // user's (server still answering) or a streaming assistant snapshot from a
    // run that outlived the panel. Once a complete assistant reply arrives,
    // fold it in and stop.
    if (demoMode || streaming || !active || (!lastMessageIsUnanswered(active) && !lastMessageIsStreaming(active))) return;
    const targetId = active.id;
    const pendingLastId = active.messages[active.messages.length - 1].id;
    // A pickup the user stopped (see stopGhostRun) is abandoned for good: the
    // run was cancelled server-side and will never complete, so without this
    // the poll would burn its whole 8-minute budget on a dead turn.
    if (abandonedPickupRef.current?.conversationId === targetId
      && abandonedPickupRef.current.lastMessageId === pendingLastId) return;
    let stopped = false;
    let attempts = 0;
    // The message count of the last snapshot: a growing transcript is a live
    // signal that the server run is still progressing.
    let lastSeenCount = active.messages.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // While polling, the conversation is being picked up without a local
    // session; surface the pickup affordances (thinking row / stop).
    setGhostConversationId(targetId);
    const tick = async () => {
      if (stopped) return;
      // The user may have stopped the pickup while a tick was scheduled or
      // in flight; abandon it (the cancelled run can never complete).
      if (abandonedPickupRef.current?.conversationId === targetId
        && abandonedPickupRef.current.lastMessageId === pendingLastId) return;
      attempts += 1;
      try {
        const fresh = await api.agentConversation(targetId);
        if (stopped) return;
        const freshLast = fresh.messages[fresh.messages.length - 1];
        // A terminal state folds in and ends the poll: the turn either
        // completed, or the server ended it with a persisted error row (which
        // no longer has anything to wait for).
        if (freshLast && freshLast.role === "assistant" && (freshLast.state === "complete" || freshLast.state === "error")) {
          const next = applyRevokedMarks(purgeStaleErrors(fresh));
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingLastId
            ? next
            : current);
          setGhostConversationId((current) => (current === targetId ? null : current));
          void refreshConversations(conversationSearch);
          return;
        }
        if (freshLast && freshLast.role === "assistant" && freshLast.state === "streaming") {
          // The in-flight reply gained content since the last read; refresh the
          // live snapshot while continuing to poll for its completion.
          const next = applyRevokedMarks(purgeStaleErrors(fresh));
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingLastId
            ? next
            : current);
        }
        // Renew the poll budget while the turn is visibly still alive on the
        // server (a streaming row, or the transcript growing). A long
        // multi-tool turn or one waiting on a desktop confirmation can exceed
        // the initial budget; it must still be folded in on completion. Only a
        // completely silent transcript burns the budget down.
        if (freshLast && freshLast.state === "streaming") {
          attempts = 0;
        } else if (fresh.messages.length > lastSeenCount) {
          attempts = 0;
          lastSeenCount = fresh.messages.length;
        }
      } catch {
        // Transient failure — keep polling until the attempt budget runs out.
      }
      if (attempts < 240) {
        timer = setTimeout(() => void tick(), 2_000);
      } else {
        // The budget ran out while the server stayed silent: the pickup is
        // dead, so drop its affordances instead of leaving a ghost row, and
        // record the abandonment so re-entering the conversation cannot arm
        // the poll for the same dead turn again.
        setGhostConversationId((current) => (current === targetId ? null : current));
        abandonedPickupRef.current = { conversationId: targetId, lastMessageId: pendingLastId };
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      setGhostConversationId((current) => (current === targetId ? null : current));
    };
  }, [active?.id, pollLastMessageId, conversationSearch, demoMode, refreshConversations, streaming]);
  // The message-scoped modes (selected_account / current_message) derive their
  // accountIds and messageIds from the currently selected message.
  // When that message is cleared, fall back to all_accounts so the composer
  // does not silently operate on a stale or empty scope.
  useEffect(() => {
    if (!currentMessage && scopeMode !== "all_accounts") {
      setScopeMode("all_accounts");
    }
  }, [currentMessage, scopeMode]);

  // Live runs keyed by conversation: while the user browses a different
  // conversation, a run keeps streaming into its buffer (no UI cost) and is
  // replayed on re-entry. Declared before selectConversation, which replays.
  const sessionStreamsRef = useRef(new Map<string, SessionStream>());

  // Re-entry: the user came back to a conversation whose run was continuing in
  // the background. The session buffer holds the complete event sequence for the
  // run, so the reply is rebuilt from it deterministically and any server
  // inFlight row (which carries the server's message id) is dropped — the reply
  // is never shown twice. Live events resume through the foreground path
  // afterwards, appending to the rebuilt row.
  const replayBackgroundSession = useCallback((session: SessionStream, conversationView: AgentConversation) => {
    const messages = conversationView.messages;
    // Only a streaming assistant row *after the last user message* can
    // belong to the current run: an interrupted previous run's inFlight row
    // sits before that user message and must never be adopted or replaced,
    // or the new run's deltas would graft onto the old partial reply.
    const lastUserIndex = messages.reduce((acc, message, i) => (message.role === "user" ? i : acc), -1);
    const liveIndex = messages.findIndex((message, i) => i > lastUserIndex && message.role === "assistant" && message.state === "streaming");
    // A reply the server already sealed (its snapshot row is terminal) must
    // not get a second row: the server may still hold the SSE open (e.g. the
    // title bump after `completed`), so by the time the user returns the
    // client session can outlive the server's inFlight row. When no live
    // streaming row exists, the server's terminal row is authoritative and
    // any client-side rebuild risks grafting a stale streaming copy on top.
    const sealedAfterLastUser = messages.some((message, i) => i > lastUserIndex && message.role === "assistant");
    let next = messages;
    if (session.events.length === 0) {
      // No deltas have arrived yet. Adopt the server's inFlight streaming row
      // if present (its id becomes the live row id); otherwise — unless the
      // server already sealed the reply — seed an empty live row so the first
      // deltas have a target instead of being dropped.
      if (liveIndex !== -1) {
        session.assistantMessageId = messages[liveIndex].id;
      } else if (!sealedAfterLastUser) {
        next = [
          ...messages,
          {
            id: session.assistantMessageId,
            role: "assistant",
            content: "",
            createdAt: currentTime(),
            state: "streaming",
            citations: [],
            toolActivities: [],
          },
        ];
      }
    } else {
      // The client buffer holds the full event sequence and is authoritative.
      // Rebuild the assistant row from scratch and replace any server inFlight
      // row (different id) in place so no duplicate reply appears.
      const base: AgentMessage = {
        id: session.assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: currentTime(),
        state: "streaming",
        citations: [],
        toolActivities: [],
      };
      let rebuilt = base;
      for (const event of session.events) rebuilt = messageWithEvent(rebuilt, event);
      next = liveIndex !== -1
        ? messages.map((message, i) => (i === liveIndex ? rebuilt : message))
        : sealedAfterLastUser
          ? messages
          : [...messages, rebuilt];
    }
    setActive({ ...conversationView, messages: next });
    // Only a replay that ended up with an actual streaming target is a live
    // run; a sealed reply (server terminal row kept) is not, and must not arm
    // the streaming affordance readers can't act on (spinner, stop, blocks).
    // A sealed run's last status is stale by definition — only restore status
    // for a run still in flight (memory suggestions are durable and stay).
    const hasLiveTarget = next.some((message, i) => i > lastUserIndex && message.role === "assistant" && message.state === "streaming");
    if (!session.done && hasLiveTarget) {
      setStreaming(true);
      if (session.status) setStreamStatus(session.status);
    }
    if (session.suggestions.length > 0) {
      setPendingMemorySuggestions((items) => {
        const merged = [...items];
        for (const suggestion of session.suggestions) if (!merged.includes(suggestion)) merged.push(suggestion);
        return merged;
      });
    }
  }, []);

  const selectConversation = useCallback(async (id: string) => {
    if (active?.id === id) return;
    // Generational guard: rapid B→C selections resolve out of order when the
    // users clicks a second conversation while the first is still fetching. The
    // token lets a stale (older) fetch recognise it was superseded and abandon
    // its late setActive instead of overwriting the newer selection.
    const token = ++selectionTokenRef.current;
    // The outgoing conversation may host a live run. It is not cancelled — it
    // keeps streaming into its session buffer while the user browses here, and
    // is replayed when they come back. The spinner/stop affordance belongs to
    // whatever is on screen, so it must follow the newly selected conversation.
    if (sessionStreamsRef.current.has(active?.id ?? "")) {
      setStreaming(false);
      setStreamStatus(null);
    }
    // Pending frame-batched deltas belong to the outgoing transcript; drop them
    // so they can never land on a different conversation.
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    pendingStreamPiecesRef.current = [];
    // Memory suggestions belong to the reply that produced them; switching
    // conversations discards whatever is undecided (a background session's
    // suggestions are replayed on re-entry).
    setPendingMemorySuggestions([]);
    try {
      setLoadError(null);
      // Optimistic switch: jump to the conversation shell right away (title
      // from the sidebar list) and fetch the record in the background. The
      // transcript shows a skeleton and the composer is gated while the shell
      // is on screen; the fetch below replaces it. A stale fetch (see the
      // generational guard) never overwrites a newer selection.
      activeIdRef.current = id;
      const summary = conversations.find((conversation) => conversation.id === id);
      setActive({
        id,
        title: summary?.title ?? "",
        preview: summary?.preview ?? "",
        updatedAt: summary?.updatedAt ?? "",
        providerId: "",
        scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
        messages: [],
      });
      setLoadingConversationId(id);
      const conversation = await api.agentConversation(id);
      if (token !== selectionTokenRef.current || activeIdRef.current !== id) return;
      setLoadingConversationId(null);
      activeIdRef.current = id;
      const conversationView = applyRevokedMarks(purgeStaleErrors(conversation));
      setActive(conversationView);
      const session = sessionStreamsRef.current.get(id);
      if (session) replayBackgroundSession(session, conversationView);
      syncBackgroundRuns();
      // Re-surface a background run's cached failure as an error row (consumed
      // once shown). Guarded by the functional updater so a live replay that
      // already rebuilt an error row does not produce a duplicate one.
      const storedError = backgroundErrorRef.current.get(id);
      if (storedError) {
        backgroundErrorRef.current.delete(id);
        setActive((current) => current && current.id === id && !current.messages.some((message) => message.role === "assistant" && message.state === "error")
          ? {
            ...current,
            messages: [...current.messages, {
              id: `background-error-${id}`,
              role: "assistant",
              state: "error",
              error: storedError,
              content: "",
              createdAt: currentTime(),
              citations: [],
              toolActivities: [],
            } satisfies AgentMessage],
          }
          : current);
      }
      // Resolve the conversation's model: a model chosen in this session wins,
      // then the one recorded on the conversation, then the default provider.
      const localProvider = conversationProviders[id];
      setProviderId(localProvider && providers.some((provider) => provider.id === localProvider && provider.configured)
        ? localProvider
        : conversation.providerId && providers.some((provider) => provider.id === conversation.providerId && provider.configured)
          ? conversation.providerId
          : configuredProviderId(providers, bootstrap?.defaultProviderId ?? null));
      setScopeMode(conversation.scope.mode);
      setRenaming(false);
      setModelPickerOpen(false);
    } catch (error) {
      if (token !== selectionTokenRef.current) return;
      setLoadingConversationId(null);
      setLoadError(error instanceof Error ? error.message : t("agent.error.loadConversation"));
      // The UI has already switched to the shell; the outgoing conversation's
      // run (if any) keeps streaming in the background and restores its live
      // indicators when replayed on re-entry.
    }
  }, [active?.id, activeIdRef, bootstrap?.defaultProviderId, conversationProviders, conversations, providers, replayBackgroundSession, syncBackgroundRuns, t]);

  const createConversation = useCallback(async () => {
    // Starting a new conversation does not cancel the current one — a live run
    // keeps streaming into its session buffer and resumes if the user returns.
    if (sessionStreamsRef.current.has(active?.id ?? "")) {
      setStreaming(false);
      setStreamStatus(null);
    }
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    pendingStreamPiecesRef.current = [];
    setPendingMemorySuggestions([]);
    if (!selectedProvider) {
      setAgentSettingsPane("providers");
      // The early return abandons the switch; restore the live indicators the
      // cleared status above so a still-running reply keeps its affordances.
      const currentSession = sessionStreamsRef.current.get(active?.id ?? "");
      if (currentSession && !currentSession.done) {
        setStreaming(true);
        if (currentSession.status) setStreamStatus(currentSession.status);
      }
      return;
    }
    // Don't create the conversation record yet — defer until the first message
    // is sent. This avoids empty conversations piling up in the history list
    // and lets the welcome screen (with the animated logo) show.
    setActive(null);
    activeIdRef.current = null;
    // Closing the panel from the welcome screen must reopen onto the welcome
    // screen, not the previously active conversation.
    try {
      window.localStorage.removeItem(LAST_ACTIVE_CONVERSATION_KEY);
    } catch {
      // Storage unavailable — the next reopen falls back to the newest conversation.
    }
    // A conversation fetch that is still in flight (selection token) must not
    // land back on screen after the user chose "new conversation": bump the
    // token so any such late fetch recognises itself as stale.
    selectionTokenRef.current += 1;
    syncBackgroundRuns();
    setComposer("");
    setAttachedFiles([]);
    setRenaming(false);
    setLoadError(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [active?.id, selectedProvider, syncBackgroundRuns]);

  const renameConversation = useCallback(async () => {
    if (!active || !draftTitle.trim()) return;
    try {
      const summary = await api.renameAgentConversation(active.id, draftTitle.trim());
      setActive((current) => current && current.id === summary.id ? { ...current, ...summary } : current);
      setConversations((items) => items.map((item) => item.id === summary.id ? summary : item));
      setRenaming(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.renameConversation"));
    }
  }, [active, draftTitle, t]);

  /**
   * Destructive delete of one or more conversations, invoked from the
   * confirmation dialog (single delete or bulk). Server-side first, then tear
   * down the local session/error bookkeeping for the ones whose delete
   * succeeded (a failed delete must not kill a nearly-finished reply).
   * Failures are surfaced via loadError but do not abort the rest of the
   * batch. Always closes the dialog and leaves multi-select mode.
   */
  const performDeleteConversations = useCallback(async (targetIds: string[]) => {
    const targets = Array.from(targetIds);
    if (targets.length === 0) return;
    setDeleteConfirm(null);
    setMultiDeleteBusy(true);
    const deleted: string[] = [];
    const errors: unknown[] = [];
    try {
      for (const id of targets) {
        try {
          await api.deleteAgentConversation(id);
          deleted.push(id);
        } catch (error) {
          errors.push(error);
        }
      }
      syncBackgroundRuns();
      for (const id of deleted) {
        const session = sessionStreamsRef.current.get(id);
        if (session) {
          session.controller.abort();
          void api.cancelAgentRun(id).catch(() => undefined);
          // Delete only the session this closure captured. If the user re-sent
          // to the same conversation while the delete was in flight, a newer
          // run has rebound the slot — wiping it would strand that run and
          // freeze the streaming flag (its teardown would no longer see itself
          // as current).
          if (sessionStreamsRef.current.get(id)?.controller === session.controller) {
            sessionStreamsRef.current.delete(id);
          }
        }
        // A cached failure must not outlive its conversation even when no
        // session is still bound (a finished run could leave one unconsumed).
        backgroundErrorRef.current.delete(id);
      }
      const deletedSet = new Set(deleted);
      setConversations((current) => current.filter((item) => !deletedSet.has(item.id)));
      if (active && deletedSet.has(active.id)) {
        const remaining = conversations.filter((item) => !deletedSet.has(item.id));
        setActive(null);
        activeIdRef.current = null;
        if (remaining[0]) void selectConversation(remaining[0].id);
      }
      setSelectedConversationIds(new Set());
      setSelectionMode(false);
      if (errors.length > 0) {
        setLoadError(errors[0] instanceof Error ? errors[0].message : t("agent.error.deleteConversation"));
      }
    } finally {
      setMultiDeleteBusy(false);
    }
  }, [active, activeIdRef, conversations, selectConversation, syncBackgroundRuns, t]);

  // Token batching: stream events (text_delta fires per token, far above the
  // display rate) are queued and flushed once per animation frame, so the row
  // re-renders and the markdown re-parse cost stay at ~60Hz instead of per
  // token. Terminal events flush immediately so the end of a turn never lags.
  // This mirrors the buffering strategy used by streaming-chat UI libraries
  // (e.g. assistant-ui) without importing their runtime.
  const pendingStreamPiecesRef = useRef<{ id: string; event: AgentStreamEvent }[]>([]);
  const streamRafRef = useRef<number | null>(null);
  const flushPendingStreamPieces = useCallback(() => {
    streamRafRef.current = null;
    const pieces = pendingStreamPiecesRef.current;
    if (pieces.length === 0) return;
    pendingStreamPiecesRef.current = [];
    const byId = new Map<string, AgentStreamEvent[]>();
    for (const piece of pieces) {
      const events = byId.get(piece.id);
      if (events) events.push(piece.event);
      else byId.set(piece.id, [piece.event]);
    }
    setActive((current) => {
      if (!current) return current;
      let messages = current.messages;
      byId.forEach((events, messageId) => {
        let row = messages.find((message) => message.id === messageId);
        if (!row) return;
        for (const event of events) row = messageWithEvent(row, event);
        messages = messages.map((message) => (message.id === messageId ? row : message));
      });
      return messages === current.messages ? current : { ...current, messages };
    });
  }, []);
  // Live runs keyed by conversation, so a run the user navigated away from can
  // keep streaming into a buffer (no UI cost) and be replayed on re-entry. When
  // the run is foreground, deltas flow through the frame batching path above.
  // (sessionStreamsRef and replayBackgroundSession live above, next to
  // selectConversation which replays a background session on re-entry.)
  const enqueueStreamPiece = useCallback((conversationId: string, messageId: string, event: AgentStreamEvent, flushNow = false) => {
    const session = sessionStreamsRef.current.get(conversationId);
    if (!session || session.assistantMessageId !== messageId) return;
    // Foreground run: surface status/suggestions/title in the live UI and push
    // message deltas through the frame-batched render path.
    if (session.conversationId === activeIdRef.current) {
      if (event.type === "status") {
        if (event.message) {
          // Mirror into the session so a later switch away and back restores
          // the last status instead of losing it.
          session.status = event.message;
          setStreamStatus(event.message);
        }
        return;
      }
      if (event.type === "memory_suggestion") {
        if (!session.suggestions.includes(event.summary)) session.suggestions.push(event.summary);
        setPendingMemorySuggestions((items) => (items.includes(event.summary) ? items : [...items, event.summary]));
        return;
      }
      if (event.type === "title") {
        setActive((current) => current && current.id === conversationId ? { ...current, title: event.title } : current);
        setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, title: event.title } : item));
        return;
      }
      if (event.type === "completed" || event.type === "error") {
        session.done = true;
        setStreamStatus(null);
      }
      // Keep the session buffer as the full event sequence for this run (even
      // while foregrounded) so a later re-entry can rebuild the row
      // identically. status/memory_suggestion/title never reach here.
      session.events.push(event);
      pendingStreamPiecesRef.current.push({ id: messageId, event });
      if (flushNow) {
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        flushPendingStreamPieces();
        return;
      }
      if (streamRafRef.current === null) {
        streamRafRef.current = requestAnimationFrame(flushPendingStreamPieces);
      }
      return;
    }
    // Background run: accumulate without rendering. Status/suggestions are kept
    // for re-entry; a terminal event marks the session complete; the remaining
    // deltas are replayed onto the message when the user returns.
    if (event.type === "status") {
      if (event.message) session.status = event.message;
      return;
    }
    if (event.type === "memory_suggestion") {
      if (!session.suggestions.includes(event.summary)) session.suggestions.push(event.summary);
      return;
    }
    if (event.type === "title") {
      // A background run still earns its sidebar title; only the active-header
      // title is deferred to re-entry (the conversation view carries it).
      setConversations((items) => items.map((item) => (item.id === conversationId ? { ...item, title: event.title } : item)));
      return;
    }
    if (event.type === "completed" || event.type === "error") session.done = true;
    // Keep a record of background failures: the server persists only successful
    // turns, so re-entry would otherwise show a bare user message with no error.
    if (event.type === "error") backgroundErrorRef.current.set(conversationId, event.error);
    session.events.push(event);
  }, [flushPendingStreamPieces]);
  useEffect(() => () => {
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onAgentConfirmationResult) return;
    return bridge.onAgentConfirmationResult((result) => {
      if (!result.ok) {
        setConfirmationErrors((current) => ({ ...current, [result.confirmationId]: t("agent.error.load") }));
        return;
      }
      setConfirmationErrors((current) => {
        if (!(result.confirmationId in current)) return current;
        const { [result.confirmationId]: _discarded, ...remaining } = current;
        return remaining;
      });
      setActive((current) => current ? {
        ...current,
        messages: current.messages.map((message) => applyConfirmationDecision(
          message,
          result.confirmationId,
          result.decision === "approve" ? "approve" : "reject",
          { approved: t("agent.confirmation.approved"), rejected: t("agent.confirmation.rejected") },
        )),
      } : current);
    });
  }, [t]);

  const sendMessage = useCallback(async (contentOverride?: string) => {
    const userText = (contentOverride ?? composer).trim();
    if (!userText) return;
    if (!selectedProvider || !selectedProvider.configured) {
      setAgentSettingsPane("providers");
      return;
    }
    // Interrupt-to-send: if the current conversation hosts a live run, sending
    // a new message folds the running reply into an "interrupted" state and
    // cancels that run (via its own controller, not the shared abortRef) before
    // the new one starts. Only the on-screen conversation is affected — a run
    // streaming in the background for another conversation keeps going.
    const activeSession = sessionStreamsRef.current.get(active?.id ?? "");
    if (activeSession && !activeSession.done) {
      const interruptLabel = t("agent.interrupted");
      activeSession.controller.abort();
      void api.cancelAgentRun(activeSession.conversationId).catch(() => undefined);
      setActive((current) => current ? {
        ...current,
        messages: current.messages.map((message) =>
          message.role === "assistant" && message.state === "streaming" ? interruptAssistantMessage(message, interruptLabel) : message,
        ),
      } : current);
      activeSession.done = true;
      // The superseded run must not hold the shared streaming flag: its own
      // teardown will see it is no longer the bound run and skip clearing it,
      // so clear here (the new run re-sets it once it starts).
      setStreaming(false);
      setStreamStatus(null);
    }
    // A run being picked up after the panel reopened has no local session to
    // interrupt. Sending a new message must still cancel it server-side,
    // otherwise the new stream races the old run and lands in the CONFLICT
    // retry window (the 5×400ms busy pause).
    if (!activeSession && ghostConversationId === active?.id) {
      void api.cancelAgentRun(ghostConversationId).catch(() => undefined);
      setGhostConversationId(null);
    }
    const files = attachedFiles;
    // Quote context from "Follow up" — sent to the LLM as truncated context,
    // the user only sees their own question in the transcript.
    const quote = quoteContext;
    const truncatedQuote = quote ? truncateForContext(quote) : undefined;
    // The transcript stores the user's clean text; extracted file content rides
    // along per attachment so the tool round-trip and model context can
    // reassemble it without polluting the visible message.
    let conversation = active;
    if (!conversation || !sameAgentScope(conversation.scope, scope)) {
      try {
        // If a concurrent send is already creating this workspace's first
        // conversation, await and reuse its record instead of orphaning a
        // second one into the sidebar.
        const pending = creatingConversationRef.current;
        if (pending) {
          conversation = await pending;
        } else {
          const promise = api.createAgentConversation({ providerId: selectedProvider.id, scope });
          creatingConversationRef.current = promise;
          try {
            conversation = await promise;
          } finally {
            creatingConversationRef.current = null;
          }
        }
        setActive(conversation);
        setConversations((items) => [{ id: conversation!.id, title: conversation!.title, preview: conversation!.preview, updatedAt: conversation!.updatedAt }, ...items.filter((item) => item.id !== conversation!.id)]);
      } catch (error) {
        creatingConversationRef.current = null;
        setLoadError(error instanceof Error ? error.message : t("agent.error.createConversation"));
        return;
      }
    }
    const attachments = files.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.path ? { path: f.path } : {}),
      ...(f.mailToken ? { token: f.mailToken } : {}),
      ...(f.mailToken && f.mailAccountId ? { accountId: f.mailAccountId } : {}),
      ...(f.text ? { text: f.text } : {}),
    }));
    const userMessage: AgentMessage = { id: newLocalId("user"), role: "user", content: userText, createdAt: currentTime(), state: "complete", citations: [], toolActivities: [], ...(attachments.length > 0 ? { attachments } : {}), ...(truncatedQuote ? { quote: truncatedQuote } : {}) };
    const assistantMessage: AgentMessage = { id: newLocalId("assistant"), role: "assistant", content: "", createdAt: currentTime(), state: "streaming", citations: [], toolActivities: [] };
    setComposer("");
    setAttachedFiles([]);
    setQuoteContext(null);
    setStreaming(true);
    setStreamStatus(null);
    setLoadError(null);
    setConfirmationErrors({});
    // Sending a new message dismisses the revoke notice immediately.
    setRevokeNoticeUntil(null);
    setActive((current) => current && current.id === conversation!.id
      ? {
        ...current,
        providerId: selectedProvider.id,
        scope,
        messages: [
          // The user has moved on: fold up the previous turn's failure
          // warnings immediately instead of waiting for this turn to succeed.
          // Empty failed messages are dropped; partial answers keep their
          // content with the error badge cleared.
          ...current.messages
            .filter((item) => !(item.error && item.content === ""))
            .map((item) => (item.error ? { ...item, error: undefined } : item)),
          userMessage,
          assistantMessage,
        ],
      }
      : current);
    // The run's routing key: events for this conversation go to the frame-batch
    // path only while it is the active one, otherwise they accumulate in the
    // session buffer for replay on re-entry.
    activeIdRef.current = conversation.id;
    // A new run supersedes any previously cached background failure for this
    // conversation; its outcome (successful or a fresh error) replaces it.
    backgroundErrorRef.current.delete(conversation.id);
    // A new run must not inherit frame-batched deltas of the interrupted one.
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    pendingStreamPiecesRef.current = [];
    const controller = new AbortController();
    abortRef.current = controller;
    // Liveness is per-conversation: this run stays current as long as it is
    // still the session bound to its own conversation. Another conversation
    // starting its own run must not silence this one — while it streams in the
    // background its events keep buffering for re-entry.
    const isCurrentRun = () => {
      const bound = sessionStreamsRef.current.get(conversation.id);
      return bound !== undefined && bound.controller === controller;
    };
    const streamSession: SessionStream = {
      conversationId: conversation.id,
      assistantMessageId: assistantMessage.id,
      controller,
      events: [],
      status: null,
      suggestions: [],
      done: false,
    };
    // A run may already be bound to this conversation slot — the interrupt path
    // above covers the visible case, but a concurrent send (double-send through
    // the creation lock) or one whose teardown is still unwinding can arrive
    // here with a live session still in place. The slot rebind silences the old
    // run, so fold its assistant row now; otherwise its earlier transcript row
    // never gets a terminal event and lingers as a spinning placeholder with no
    // self-healing path.
    const prior = sessionStreamsRef.current.get(conversation.id);
    if (prior && !prior.done) {
      prior.controller.abort();
      // Aborting the socket only stops delivery — the server's run unwinds to
      // completion and keeps claiming the conversation's active-run slot
      // (tokens keep burning, and the new stream below would eat CONFLICTs).
      // Cancel the server-side run like every other supersede path does.
      void api.cancelAgentRun(prior.conversationId).catch(() => undefined);
      setActive((current) => current && current.id === conversation.id
        ? {
          ...current,
          messages: current.messages.map((message) =>
            message.id === prior.assistantMessageId && message.state === "streaming"
              ? interruptAssistantMessage(message, t("agent.interrupted"))
              : message,
          ),
        }
        : current);
    }
    sessionStreamsRef.current.set(conversation.id, streamSession);
    syncBackgroundRuns();
    const streamPayload: Parameters<typeof api.streamAgentMessage>[1] = {
      content: userText,
      providerId: selectedProvider.id,
      mode,
      scope,
      context: {
        ...(currentMessage ? { currentMessageId: currentMessage.id } : {}),
      },
      ...(truncatedQuote ? { quote: truncatedQuote } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    // A still-unwinding previous run on the server can briefly reject the new
    // stream with CONFLICT. We retry a few times (swallowing the conflict and
    // its trailing events) until the old run finishes tearing down.
    let conflictRetries = 0;
    const MAX_CONFLICT_RETRIES = 5;
    // Set when this run ends in an error terminal. The failure row must stay
    // visible for retry, so the success cleanup below must not fold it away.
    let turnFailed = false;
    try {
      for (;;) {
        let conflictRetry = false;
        await api.streamAgentMessage(conversation.id, streamPayload, (event) => {
          // A cancelled run may still emit buffered events as it unwinds. They
          // belong to a superseded run and must not touch the current one.
          if (!isCurrentRun()) return;
          if (event.type === "error" && event.error.code === "CONFLICT" && !controller.signal.aborted && conflictRetries < MAX_CONFLICT_RETRIES) {
            conflictRetry = true;
            return;
          }
          // Once this attempt hit a conflict, drop the rest of its events
          // (including the trailing completed/error) so the assistant message
          // is not wrongly marked; the retry below restarts cleanly.
          if (conflictRetry) return;
          if (event.type === "error") turnFailed = true;
          if (event.type === "completed" && event.reason === "error") turnFailed = true;
          enqueueStreamPiece(conversation.id, streamSession.assistantMessageId, event, event.type === "completed" || event.type === "error");
        }, controller.signal);
        if (!conflictRetry) break;
        if (controller.signal.aborted) return;
        conflictRetries += 1;
        // The retry pause belongs to the run that is waiting; only surface the
        // busy notice on the screen if that run is the one being viewed.
        if (activeIdRef.current === conversation.id) setStreamStatus(t("agent.error.streamBusy"));
        // Give the superseded run time to release the conversation on the server.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        // An abort may have raced with the retry delay; do not restart a stream
        // that is no longer wanted.
        if (controller.signal.aborted) return;
      }
      // A successful turn clears stale failure rows — both the one the retry
      // targeted and any others left behind — so the transcript stops showing
      // outdated errors once the conversation moves on. A run that itself
      // failed keeps its error row for the user to retry. Only touch the
      // transcript when it is the one on screen; a run that finished in the
      // background cleans up its own view on re-entry via the server snapshot.
      if (!turnFailed && activeIdRef.current === conversation.id) {
        setActive((current) => current ? {
          ...current,
          messages: current.messages
            .filter((item) => !(item.error && item.content === ""))
            .map((item) => (item.error ? { ...item, error: undefined } : item)),
        } : current);
      }
      await refreshConversations(conversationSearch);
    } catch (error) {
      if (!isCurrentRun()) return;
      if (controller.signal.aborted) {
        enqueueStreamPiece(conversation.id, streamSession.assistantMessageId, { type: "completed", reason: "cancelled" }, true);
      } else {
        const code = error instanceof ApiError ? error.code ?? "agent_request_failed" : "agent_request_failed";
        const message = code === "agent_stream_unavailable"
          ? t("agent.error.streamUnavailable")
          : code === "agent_stream_invalid"
            ? t("agent.error.streamInvalid")
            : error instanceof Error ? error.message : t("agent.error.stream");
        enqueueStreamPiece(conversation.id, streamSession.assistantMessageId, { type: "error", error: { code, message, retryable: true } }, true);
      }
    } finally {
      // Only the latest run may clear shared run state; a superseded run's
      // teardown must not drop the streaming flag of the run that replaced it.
      // A background-completed run clears nothing: the streaming flag belongs
      // to whatever conversation is on screen.
      if (isCurrentRun()) {
        if (abortRef.current === controller) abortRef.current = null;
        if (activeIdRef.current === conversation.id) {
          setStreaming(false);
          setStreamStatus(null);
        }
      }
      // Remove this run's session once it ends. Re-entry afterwards simply
      // renders the server-persisted transcript, so the client buffer is no
      // longer needed. Guarded by controller identity so an interrupt-to-send
      // that replaced this session cannot be wiped by the old run's teardown.
      const ended = sessionStreamsRef.current.get(conversation.id);
      if (ended && ended.controller === controller) sessionStreamsRef.current.delete(conversation.id);
      syncBackgroundRuns();
    }
  }, [active, attachedFiles, composer, conversationSearch, currentMessage, enqueueStreamPiece, ghostConversationId, mode, quoteContext, refreshConversations, scope, selectedProvider, syncBackgroundRuns, t]);

  const stopStreaming = useCallback(() => {
    const conversationId = active?.id;
    if (!conversationId) return;
    const session = sessionStreamsRef.current.get(conversationId);
    // The on-screen conversation may be mid-run (user pressed stop) or have no
    // run at all. Cancel through the session's own controller so a background
    // run from another conversation can never be stopped by mistake.
    if (session) {
      session.controller.abort();
      void api.cancelAgentRun(session.conversationId).catch(() => undefined);
    }
  }, [active?.id]);

  // Stop affordance for a run being picked up after the panel reopened: there
  // is no local controller, only the server-side run — cancel it directly.
  const stopGhostRun = useCallback(() => {
    const conversationId = ghostConversationId;
    if (!conversationId) return;
    void api.cancelAgentRun(conversationId).catch(() => undefined);
    // Abandon the pickup for this last message: the cancelled run never
    // persists a completed turn, so the transcript stays at the last user
    // message (same as an interrupted turn after a stop), and the poll must
    // not keep waiting on a turn that can never complete.
    if (active?.id === conversationId) {
      const last = active.messages[active.messages.length - 1];
      if (last) abandonedPickupRef.current = { conversationId, lastMessageId: last.id };
    }
    setGhostConversationId((current) => (current === conversationId ? null : current));
  }, [ghostConversationId, active?.id]);

  // Slash command menu: while the composer holds a bare "/token" the matching
  // commands are offered. Parameterless commands send immediately; commands
  // with parameters are completed into the composer for editing. Expansion
  // itself happens on the server, which validates the controlled command set.
  // Slash commands are mail-operation scoped: only the mail-assistant mode
  // builds the menu, plain chat ignores the leading "/".
  const slashMenu = useMemo(() => mode === "agent" ? buildSlashMenu(composer, { streaming, dismissed: slashDismissed }) : null, [composer, slashDismissed, mode, streaming]);
  const activeSlashIndex = slashMenuActiveIndex(slashMenu, slashIndex);
  const completeSlash = useCallback((command: AgentSlashCommand, sub?: AgentSlashSubcommand) => {
    setSlashDismissed(!slashKeepsMenuOpen(command, sub));
    const text = slashCompletionText(command, sub);
    if (!command.requiresParam && !sub) {
      setComposer(`/${command.name}`);
      void sendMessage(`/${command.name}`);
      return;
    }
    setComposer(text);
    window.requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, [sendMessage]);
  useEffect(() => {
    if (!slashMenu) setSlashIndex(0);
  }, [slashMenu]);

  const scopeOptions: Array<{ mode: AgentScopeMode; label: string; title: string; disabled?: boolean }> = [
    { mode: "all_accounts", label: t("agent.scope.all"), title: t("agent.scope.all.tooltip") },
    { mode: "selected_account", label: t("agent.scope.account"), title: t("agent.scope.account.tooltip"), disabled: !currentMessage },
    { mode: "current_message", label: t("agent.scope.message"), title: t("agent.scope.message.tooltip"), disabled: !currentMessage },
  ];
  const permissionOptions: Array<{ level: AgentAccessLevel; label: string; hint: string; detail: string; features: string[]; icon: ReactNode }> = [
    { level: "read-only", label: t("agent.permission.readOnly"), hint: t("agent.permission.readOnly.hint"), detail: t("agent.permission.readOnly.detail"), features: [t("agent.permission.readOnly.feature1"), t("agent.permission.readOnly.feature2"), t("agent.permission.readOnly.feature3")], icon: <Eye size={12} /> },
    { level: "send-confirmed", label: t("agent.permission.confirmed"), hint: t("agent.permission.confirmed.hint"), detail: t("agent.permission.confirmed.detail"), features: [t("agent.permission.confirmed.feature1"), t("agent.permission.confirmed.feature2"), t("agent.permission.confirmed.feature3")], icon: <ShieldCheck size={12} /> },
    { level: "full-access", label: t("agent.permission.fullAccess"), hint: t("agent.permission.fullAccess.hint"), detail: t("agent.permission.fullAccess.detail"), features: [t("agent.permission.fullAccess.feature1"), t("agent.permission.fullAccess.feature2"), t("agent.permission.fullAccess.feature3")], icon: <Zap size={12} /> },
  ];
  const cloudMailContextBlocked = Boolean(selectedProvider?.cloud && !selectedProvider.cloudContentConsent);
  const currentPermissionLabel = permissionOptions.find((option) => option.level === agentAccessLevel)?.label;
  const permissionPopover = useMountedVisible(permissionOpen);
  const modelPopover = useMountedVisible(modelPickerOpen);
  // Switching to plain chat hides the permission trigger; close the popover
  // so it does not resurface stale-open when switching back to agent mode.
  useEffect(() => { setPermissionOpen(false); }, [mode]);
  // The composer stays editable when there is a configured provider. Demo mode
  // ignores the server-side enabled flag so the textarea/model picker remain
  // interactive for UI demonstration, while sending stays disabled below.
  // The composer stays editable while the agent runs so the user can type the
  // next message and interrupt-send it; only an unconfigured/disabled backend
  // locks the field. Sending is always allowed mid-run (it interrupts).
  const composerDisabled = !hasConfiguredProvider || (!demoMode && !bootstrap?.enabled);
  // Sending is never available in demo mode (there is no Agent backend).
  const sendDisabled = demoMode || !composer.trim() || composerDisabled || (mode === "agent" && cloudMailContextBlocked)
    || loadingConversationId === active?.id;

  const latestCitations = useMemo(() => {
    if (!active) return [];
    for (let i = active.messages.length - 1; i >= 0; i--) {
      const msg = active.messages[i]!;
      if (msg.role === "assistant" && msg.citations.length > 0) return dedupeCitations(msg.citations);
    }
    return [];
  }, [active]);

  const desktopConfirmationAvailable = Boolean(desktopBridge()?.onAgentConfirmationResult);
  // The active confirmation (one at a time) floats above the composer, opencode
  // style, instead of interrupting the conversation stream.
  const pendingConfirmation = useMemo(() => {
    for (const message of active?.messages ?? []) {
      if (message.confirmation?.state === "pending") return message.confirmation;
    }
    return undefined;
  }, [active]);
  // The confirmation card owns a local ticking countdown, so a waiting
  // confirmation no longer re-renders the whole transcript every second.
  const confirmationDeadline = pendingConfirmation ? Date.parse(pendingConfirmation.expiresAt) : 0;
  const expirePendingConfirmation = useCallback(() => {
    // Runs from the card's expiry tick when the pending confirmation can no
    // longer be resolved, so use the live state instead of a captured id.
    const confirmationId = pendingConfirmation?.id;
    if (!confirmationId) return;
    setActive((current) => current ? {
      ...current,
      messages: current.messages.map((message) => expireConfirmation(message, confirmationId, t("agent.confirmation.expired"))),
    } : current);
  }, [pendingConfirmation, t]);
  // "已撤回信息" notice above the composer: a countdown that clears on its own
  // or the moment the user sends a new message. The ticking countdown lives in
  // the notice itself; this just records the deadline.
  const [revokeNoticeUntil, setRevokeNoticeUntil] = useState<number | null>(null);
  const revokeNoticeActive = revokeNoticeUntil !== null;
/** Message ids whose revoke/unrevoke request is still in flight. Duplicate
 *  clicks are ignored while pending (idempotent server endpoint). */
  const pendingRevokeIdsRef = useRef<ReadonlySet<string>>(new Set());
  const resolveDemoConfirmation = useCallback((confirmationId: string, decision: "approve" | "reject") => {
    setActive((current) => current ? {
      ...current,
      messages: current.messages.map((message) => applyConfirmationDecision(message, confirmationId, decision, {
        approved: t("agent.confirmation.approved"),
        rejected: t("agent.confirmation.rejected"),
      })),
    } : current);
  }, [t]);
  const revokeMessage = useCallback((messageId: string) => {
    const revokeTarget = activeMessagesRef.current?.find((message) => message.id === messageId);
    const conversationId = active?.id;
    if (!conversationId || pendingRevokeIdsRef.current.has(messageId)) return;
    // Optimistic update: the transcript hides the message immediately. The
    // server is reconciled afterwards; on failure the local mark is rolled back.
    const revokedSet = new Set<string>();
    setActive((current) => {
      if (!current) return current;
      const index = current.messages.findIndex((message) => message.id === messageId);
      if (index < 0) return current;
      const revokedIds = new Set(readRevokedIds(current.id));
      revokedIds.add(messageId);
      // Revoking a user message also cuts off (revokes) every assistant
      // message that followed it before a new user turn, keeping the transcript
      // coherent with its context.
      if (current.messages[index]!.role === "user") {
        for (let i = index + 1; i < current.messages.length; i++) {
          const follow = current.messages[i]!;
          if (follow.role === "user") break;
          revokedIds.add(follow.id);
        }
      }
      revokedSet.clear();
      revokedIds.forEach((id) => revokedSet.add(id));
      writeRevokedIds(current.id, revokedIds);
      return { ...current, messages: current.messages.map((message) => (revokedIds.has(message.id) ? { ...message, revoked: true } : message)) };
    });
    // Revoking the user's own message returns its text to the composer so it
    // can be edited and resent; the assistant reply has no text to recover and
    // stays revoked. A small "已撤回信息" notice (with a countdown) shows above
    // the composer and clears as soon as the user sends a new message.
    if (revokeTarget?.role === "user" && revokeTarget.content) {
      setComposer(revokeTarget.content);
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
    setRevokeNoticeUntil(Date.now() + REVOKE_NOTICE_SECONDS * 1000);
    // Server reconciliation: idempotent, duplicates ignored while in flight.
    pendingRevokeIdsRef.current = new Set(pendingRevokeIdsRef.current).add(messageId);
    void api.revokeAgentMessage(conversationId, messageId, true).catch(() => {
      // Roll back the optimistic marks so the transcript matches the server.
      setActive((current) => {
        if (!current) return current;
        const revokedIds = new Set(readRevokedIds(current.id));
        revokedSet.forEach((id) => revokedIds.delete(id));
        writeRevokedIds(current.id, revokedIds);
        return { ...current, messages: current.messages.map((message) => (revokedSet.has(message.id) ? { ...message, revoked: false } : message)) };
      });
      setLoadError(t("agent.message.revokeFailed"));
    }).finally(() => {
      const next = new Set(pendingRevokeIdsRef.current);
      next.delete(messageId);
      pendingRevokeIdsRef.current = next;
    });
  }, [active?.id, t]);

  return (
    <section ref={workspaceRef} className="agent-workspace" role="dialog" aria-modal="true" aria-label={t("agent.workspace.aria")} tabIndex={-1}>
      {mobileConversationsOpen && <button className="agent-mobile-conversation-scrim" type="button" aria-label={t("agent.conversation.closeList")} onClick={() => setMobileConversationsOpen(false)} />}
      <aside className={`agent-conversation-sidebar${mobileConversationsOpen ? " mobile-open" : ""}`}>
        <div className="agent-sidebar-top">
          <div className="agent-mode-switch" role="group" aria-label={t("agent.mode.label")} data-mode={mode}>
            <span className="agent-mode-thumb" aria-hidden="true" />
            <button type="button" className={mode === "agent" ? "active" : ""} aria-pressed={mode === "agent"} onClick={() => setMode("agent")}><Bot size={14} />{t("agent.mode.agent")}</button>
            <button type="button" className={mode === "chat" ? "active" : ""} aria-pressed={mode === "chat"} onClick={() => setMode("chat")}><MessageCircle size={14} />{t("agent.mode.chat")}</button>
          </div>
          <button className="agent-new-conversation-button" type="button" onClick={() => { setMobileConversationsOpen(false); void createConversation(); }} disabled={demoMode} aria-label={t("agent.conversation.new")} data-tooltip={t("agent.conversation.new")}><MessageCirclePlus size={16} /></button>
        </div>
        <div className="agent-sidebar-search"><Search size={15} /><label className="visually-hidden" htmlFor="agent-conversation-search">{t("agent.conversation.search")}</label><input id="agent-conversation-search" value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder={t("agent.conversation.searchPlaceholder")} /></div>
        <div className="agent-conversation-list" onContextMenu={(event) => { if ((event.target as HTMLElement).closest(".agent-conversation-row")) return; openConversationMenu(event, null); }}>
          {loading && <div className="agent-sidebar-state"><LoaderCircle className="spin" size={18} />{t("agent.loading")}</div>}
          {!loading && !filteredConversations.length && <div className="agent-sidebar-state"><MessageCircle size={18} />{t("agent.conversation.empty")}</div>}
          <div className={`agent-selection-bar-wrap${selectionMode ? " open" : ""}`} aria-hidden={!selectionMode}>
            <div className="agent-selection-bar">
              <span className="agent-selection-count">{t("agent.conversation.selected")} {selectedConversationIds.size}</span>
              <button className="agent-selection-delete" type="button" disabled={multiDeleteBusy || selectedConversationIds.size === 0 || Array.from(selectedConversationIds).some((id) => backgroundRunIds.has(id) || (active?.id === id && streaming))} onClick={() => setDeleteConfirm(Array.from(selectedConversationIds))}><Trash2 size={14} />{t("agent.conversation.deleteSelected")}</button>
              <button className="agent-selection-cancel" type="button" onClick={exitSelectionMode}><X size={14} />{t("common.cancel")}</button>
            </div>
          </div>
          {filteredConversations.map((conversation) => (
            <div key={conversation.id} className={`agent-conversation-row ${active?.id === conversation.id ? "active" : ""}${selectionMode ? " selectable" : ""}`} onContextMenu={(event) => openConversationMenu(event, conversation.id)}>
              {selectionMode && <button className={`agent-row-check ${selectedConversationIds.has(conversation.id) ? "checked" : ""}`} type="button" aria-label={t("agent.conversation.toggleSelect")} aria-pressed={selectedConversationIds.has(conversation.id)} disabled={backgroundRunIds.has(conversation.id) || (active?.id === conversation.id && streaming)} onClick={() => toggleConversationSelected(conversation.id)}><SquareCheck size={14} /></button>}
              <button className="agent-conversation-open" type="button" onClick={() => { setMobileConversationsOpen(false); if (selectionMode) toggleConversationSelected(conversation.id); else void selectConversation(conversation.id); }}><span><strong>{conversation.title}</strong>{backgroundRunIds.has(conversation.id) && <LoaderCircle className="spin" size={13} aria-label={t("agent.conversation.backgroundRunning")} />}<small>{conversation.preview || t("agent.conversation.emptyPreview")}</small></span><time>{shortDate(conversation.updatedAt, locale)}</time></button>
              {!selectionMode && <button className="agent-row-delete" type="button" aria-label={t("agent.conversation.delete")} disabled={backgroundRunIds.has(conversation.id) || (active?.id === conversation.id && streaming)} onClick={() => setDeleteConfirm([conversation.id])}><Trash2 size={14} /></button>}
            </div>
          ))}
        </div>
        {sidebarMenu && (
          <div className="agent-context-menu" ref={sidebarMenuRef} style={{ left: Math.min(sidebarMenu.x, Math.max(8, window.innerWidth - 160)), top: Math.min(sidebarMenu.y, Math.max(8, window.innerHeight - 200)) }} role="menu" onClick={(e) => e.stopPropagation()}>
            {sidebarMenu.conversationId === null ? (
              <button type="button" role="menuitem" onClick={() => runMenuAction(() => void createConversation())}><MessageCirclePlus size={14} /><span>{t("agent.conversation.new")}</span></button>
            ) : (
              <>
                <button type="button" role="menuitem" disabled={backgroundRunIds.has(sidebarMenu.conversationId) || (active?.id === sidebarMenu.conversationId && streaming)} onClick={() => { const id = sidebarMenu.conversationId!; runMenuAction(() => setDeleteConfirm([id])); }}><Trash2 size={14} /><span>{t("agent.conversation.delete")}</span></button>
                <button type="button" role="menuitem" onClick={() => { const id = sidebarMenu.conversationId!; runMenuAction(() => enterSelectionMode(id)); }}><SquareCheck size={14} /><span>{t("agent.conversation.multiSelect")}</span></button>
                <button type="button" role="menuitem" onClick={() => { const id = sidebarMenu.conversationId!; runMenuAction(() => void selectConversation(id).then(() => { setDraftTitle(conversations.find((item) => item.id === id)?.title ?? ""); setRenaming(true); })); }}><Pencil size={14} /><span>{t("agent.conversation.rename")}</span></button>
                <button type="button" role="menuitem" onClick={() => { const id = sidebarMenu.conversationId!; runMenuAction(() => void downloadConversation(id, "markdown")); }}><FileText size={14} /><span>{t("agent.conversation.exportMarkdown")}</span></button>
                <button type="button" role="menuitem" onClick={() => { const id = sidebarMenu.conversationId!; runMenuAction(() => void downloadConversation(id, "json")); }}><FileDown size={14} /><span>{t("agent.conversation.exportJson")}</span></button>
              </>
            )}
          </div>
        )}
        <div className="agent-sidebar-footer"><Bot size={15} /><span>{t("agent.localBoundary")}</span></div>
      </aside>

      <section className="agent-main-panel">
        <header className="agent-workspace-header">
          <div className="agent-conversation-heading">
            <span className="agent-heading-mark" aria-hidden="true"><AgentMark size={21} /></span>
            {renaming && active ? (
              <form onSubmit={(event) => { event.preventDefault(); void renameConversation(); }}><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label={t("agent.conversation.rename")} autoFocus onBlur={() => setRenaming(false)} /></form>
            ) : <div className="agent-conversation-title"><span className="eyebrow">{t("agent.eyebrow")}</span><span className="agent-title-line"><h1 title={active?.title}>{active?.title ?? t("agent.conversation.newTitle")}</h1>{active && <button className="icon-button" type="button" aria-label={t("agent.conversation.rename")} data-tooltip={t("agent.conversation.rename")} onClick={() => { setDraftTitle(active.title); setRenaming(true); }}><Pencil size={15} /></button>}</span></div>}
          </div>
          <div className="agent-header-actions">
            <div className="agent-scope-switch" role="group" aria-label={t("agent.scope.label")} data-scope={scopeMode}>
              <span className="agent-scope-thumb" aria-hidden="true" />
              {scopeOptions.map((option) => <button key={option.mode} type="button" className={scopeMode === option.mode ? "active" : ""} aria-pressed={scopeMode === option.mode} disabled={option.disabled} data-tooltip={option.title} onClick={() => setScopeMode(option.mode)}>{option.label}</button>)}
            </div>
            <button className="agent-mobile-conversations-button" type="button" aria-label={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} aria-expanded={mobileConversationsOpen} data-tooltip={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} onClick={() => setMobileConversationsOpen((open) => !open)}><PanelLeftClose size={17} /></button>
            {!hasConfiguredProvider ? <button ref={providerSettingsTriggerRef} className="agent-configure-provider-action" type="button" onClick={() => setAgentSettingsPane("providers")}><Wrench size={15} />{t("agent.providers.configure")}</button> : null}
            {hasConfiguredProvider && <button ref={providerSettingsTriggerRef} className="icon-button" type="button" onClick={() => setAgentSettingsPane("providers")} aria-label={t("agent.provider.settings")} data-tooltip={t("agent.provider.settings")}><Wrench size={17} /></button>}
            <button className="icon-button" type="button" onClick={onClose} aria-label={t("agent.workspace.close")} data-tooltip={t("agent.workspace.close")}><X size={18} /></button>
          </div>
        </header>

        <div className="agent-context-strip">
          <div className="agent-mode-switch strip-mode" role="group" aria-label={t("agent.mode.label")} data-mode={mode}>
            <span className="agent-mode-thumb" aria-hidden="true" />
            <button type="button" className={mode === "agent" ? "active" : ""} aria-pressed={mode === "agent"} onClick={() => setMode("agent")}><Bot size={14} />{t("agent.mode.agent")}</button>
            <button type="button" className={mode === "chat" ? "active" : ""} aria-pressed={mode === "chat"} onClick={() => setMode("chat")}><MessageCircle size={14} />{t("agent.mode.chat")}</button>
          </div>
          {selectedProvider?.cloud && !selectedProvider.cloudContentConsent && <span className="agent-privacy-notice"><ShieldAlert size={14} />{t("agent.provider.consentRequired")}</span>}
          {currentMessage && <span className="agent-current-context"><FileText size={14} />{currentMessage.subject || t("agent.context.currentMessage")}</span>}
        </div>

        <div className="agent-transcript-wrap">
        <div className="agent-transcript" ref={transcriptRef} aria-live="polite" onContextMenu={handleTranscriptContextMenu}>
          {loadError && <div className="agent-error-panel" role="status"><CircleAlert size={18} /><span><strong>{t("agent.error.title")}</strong><small>{loadError}</small></span><button className="secondary-button" type="button" onClick={() => void loadBootstrap()}>{t("common.retry")}</button></div>}
          {loadingConversationId === active?.id && active && (
            // Optimistic switch: the record is still being fetched — show a
            // skeleton mirroring the real message layout (right-aligned user
            // bubble, left-aligned assistant lines, timestamp rows).
            <div className="agent-transcript-loading" aria-hidden="true">
              <article className="agent-message skeleton user">
                <div className="agent-skeleton-bubble">
                  <div className="agent-skeleton-content">
                    <div className="agent-skeleton-line" style={{ width: "74%" }} />
                    <div className="agent-skeleton-line" style={{ width: "46%" }} />
                  </div>
                </div>
                <div className="agent-message-meta"><span className="agent-skeleton-chrome" /></div>
              </article>
              <article className="agent-message skeleton assistant">
                <div className="agent-skeleton-content">
                  <div className="agent-skeleton-line" style={{ width: "88%" }} />
                  <div className="agent-skeleton-line" style={{ width: "70%" }} />
                  <div className="agent-skeleton-line" style={{ width: "78%" }} />
                  <div className="agent-skeleton-line" style={{ width: "42%" }} />
                </div>
                <div className="agent-message-meta"><span className="agent-skeleton-chrome" /></div>
              </article>
            </div>
          )}
          {!loading && !active && <div className="agent-empty-state"><span className="agent-wordmark" aria-hidden="true">{"NamiMailAgent".split("").map((char, index) => <span key={index} style={{ animationDelay: `${index * 0.05}s` }}>{char}</span>)}</span>{hasConfiguredProvider ? <div className="agent-suggestion-cards"><button className="agent-suggestion-card" type="button" onClick={() => setComposer(t("agent.suggestion.today"))}><CalendarDays size={17} /><span>{t("agent.suggestion.today")}</span></button><button className="agent-suggestion-card" type="button" onClick={() => setComposer(t("agent.suggestion.actionItems"))}><ClipboardList size={17} /><span>{t("agent.suggestion.actionItems")}</span></button><button className="agent-suggestion-card" type="button" onClick={() => setComposer(t("agent.suggestion.reply"))}><Reply size={17} /><span>{t("agent.suggestion.reply")}</span></button></div> : <button className="agent-configure-provider-button" type="button" onClick={() => setAgentSettingsPane("providers")}><Wrench size={16} />{t("agent.providers.configure")}</button>}</div>}
          {active?.messages.map((message, index) => (
            <AgentMessageRow
              key={message.id}
              message={message}
              superseded={index < lastUserMessageIndex}
              statusMessage={streamStatus}
              locale={locale}
              t={t}
              onOpenAttachment={openAttachmentFolder}
              onRevoke={revokeMessage}
              onRetry={retryLastUserTurn}
              onUserMessageRef={registerUserMessageEl}
            />
          ))}
          {ghostConversationId === active?.id && active && lastMessageIsUnanswered(active)
            && !active.messages.some((message) => message.role === "assistant" && message.state === "streaming") && (
            // A run being picked up after the panel reopened has no captured
            // tool events, so the local snapshot has no streaming row to show
            // while the pre-content phase (the automatic mail search) runs.
            // Render a thinking row locally; the fold-in poll replaces it with
            // the server's in-flight row or the completed reply.
            <AgentMessageRow
              message={{ id: `pickup-${active.id}`, role: "assistant", content: "", createdAt: currentTime(), state: "streaming", citations: [], toolActivities: [] }}
              superseded={false}
              statusMessage={null}
              locale={locale}
              t={t}
              onOpenAttachment={openAttachmentFolder}
              onRevoke={revokeMessage}
              onRetry={retryLastUserTurn}
              onUserMessageRef={registerUserMessageEl}
            />
          )}
          <div ref={messagesEndRef} />
          {contextMenu && (
            <div className="agent-context-menu" ref={contextMenuRef} style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => { void copyToClipboard(contextMenu.text); setContextMenu(null); }}><Copy size={14} /><span>{t("agent.message.copy")}</span></button>
              <button type="button" role="menuitem" onClick={() => { setQuoteContext(contextMenu.text); setContextMenu(null); window.requestAnimationFrame(() => composerRef.current?.focus()); }}><ArrowUp size={14} /><span>{t("agent.message.followUp")}</span></button>
            </div>
          )}
        </div>
        {userMessages.length > 0 && (
          <div
            className="agent-scrubber"
            role="presentation"
            ref={scrubberTrackRef}
            onMouseLeave={() => {
              window.clearTimeout(scrubberPreviewTimerRef.current);
              setShowScrubberPreview(false);
              setHoveredUserIndex(null);
            }}
            onMouseMove={handleScrubberMove}
            onWheel={handleScrubberWheel}
            onClick={() => { if (hoveredUserIndex !== null) jumpToUserMessage(hoveredUserIndex); }}
          >
            {scrubberViewport !== null && userMessages.map((message, index) => {
              // Bars are spaced at a fixed interval; the group's viewport
              // offset places it (centred when it fits, bottom-anchored when
              // it overflows) and edge-zone auto-scroll moves the group. Bars
              // near the track edges blur to dissolve into the boundary.
              const barTop = scrubberViewport + index * SCRUBBER_BAR_GAP;
              const blur = scrubberTrackHeight > 0 ? scrubberBarBlur(barTop, scrubberTrackHeight) : 0;
              return (
                <AgentScrubberBar
                  key={message.id}
                  hovered={hoveredUserIndex === index}
                  top={barTop}
                  width={scrubberBarWidth(index, hoveredUserIndex)}
                  blur={blur}
                />
              );
            })}
            {hoveredUserMessage && showScrubberPreview && scrubberViewport !== null && (
              <div
                className="agent-scrubber-preview"
                style={{
                  top: `clamp(14px, calc(${scrubberViewport + hoveredUserIndex! * SCRUBBER_BAR_GAP}px), calc(100% - 14px))`,
                }}
              >
                <span className="agent-scrubber-preview-bubble">{hoveredUserPreview || "…"}</span>
              </div>
            )}
          </div>
        )}
        </div>

        <footer className="agent-composer-region">
          {attachedFiles.length > 0 && (
            <div className="agent-attachment-chips">
              {attachedFiles.map((file, index) => (
                <span key={`${file.name}-${index}`} className={`agent-attachment-chip ${processingFileName === file.name ? "processing" : ""}`}>
                  <FileText size={13} />
                  <span>{file.name}</span>
                  {file.mailUploadState === "uploading" && <LoaderCircle size={11} className="spin" aria-label={t("agent.attachment.uploading")} />}
                  {file.mailUploadState === "ready" && <em className="agent-attachment-chip-note ready">{t("agent.attachment.ready")}</em>}
                  {file.mailUploadState === "failed" && <em className="agent-attachment-chip-note failed">{t("agent.attachment.failed")}</em>}
                  <button type="button" onClick={() => removeAttachedFile(index)} aria-label={t("agent.composer.removeAttachment")}><X size={11} /></button>
                </span>
              ))}
              {processingFileName && attachedFiles.every((f) => f.name !== processingFileName) && (
                <span className="agent-attachment-chip processing">
                  <LoaderCircle size={13} className="spin" />
                  <span>{processingFileName}</span>
                </span>
              )}
            </div>
          )}
          {quoteContext && (
            <div className="agent-quote-preview">
              <span className="agent-quote-mark" aria-hidden="true">"</span>
              <span className="agent-quote-text">{truncateForPreview(quoteContext)}</span>
              <span className="agent-quote-mark" aria-hidden="true">"</span>
              <button type="button" onClick={() => setQuoteContext(null)} aria-label={t("common.dismiss")}><X size={12} /></button>
            </div>
          )}
          {revokeNoticeActive && <RevokeNotice until={revokeNoticeUntil!} onExpire={() => setRevokeNoticeUntil(null)} />}
          {pendingConfirmation && <AgentConfirmationCard
            confirmation={pendingConfirmation}
            desktopConfirmationAvailable={desktopConfirmationAvailable}
            resolutionError={confirmationErrors[pendingConfirmation.id]}
            onDecision={demoMode ? (decision) => resolveDemoConfirmation(pendingConfirmation.id, decision) : undefined}
            expiresAt={Number.isFinite(confirmationDeadline) && confirmationDeadline > 0 ? confirmationDeadline : undefined}
            onExpire={expirePendingConfirmation}
          />}
          <div className={`agent-composer${streaming ? " streaming" : ""}`}>
            <button className={`agent-scroll-to-bottom ${showScrollToBottom ? "visible" : ""}`} type="button" onClick={scrollToBottom} aria-label={t("agent.composer.scrollToBottom")}><ChevronDown size={17} /></button>
            <input ref={fileInputRef} type="file" multiple onChange={(e) => void handleFileSelect(e)} accept=".txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.py,.js,.ts,.tsx,.jsx,.css,.scss,.less,.yaml,.yml,.log,.rtf,.ini,.cfg,.conf,.sh,.bash,.zsh,.sql,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.vue,.svelte,.pdf,.docx,.pptx" style={{ display: "none" }} />
            <label className="visually-hidden" htmlFor="agent-composer">{t("agent.composer.label")}</label>
            <textarea id="agent-composer" ref={composerRef} value={composer} onChange={(event) => { setComposer(event.target.value); setSlashDismissed(false); }} onKeyDown={(event) => {
              const composing = (event.nativeEvent as KeyboardEvent).isComposing;
              // While the slash menu is open, arrows/tab/enter drive it instead
              // of the composer's default editing and send behavior.
              if (slashMenu && !composing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((index) => (index + delta + slashMenu.length) % slashMenu.length);
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  const active = slashMenu[activeSlashIndex];
                  if (active) {
                    if (active.kind === "sub") completeSlash(active.command, active.sub);
                    else completeSlash(active.command);
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              // Ignore Enter while an IME composition is active (e.g. confirming
              // pinyin) so the message is not sent mid-composition.
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                void sendMessage();
              }
            }} placeholder={t("agent.composer.placeholder")} disabled={composerDisabled} rows={1} aria-expanded={slashMenu !== null && slashMenu.length > 0} aria-controls="agent-slash-menu" />
            {slashMenu && slashMenu.length > 0 && (
              <div className="agent-slash-menu" id="agent-slash-menu" role="listbox" aria-label={t("agent.commands.label")}>
                {slashMenu.map((item, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeSlashIndex}
                    key={item.kind === "sub" ? `${item.command.id}.${item.sub.name}` : item.command.id}
                    className={`agent-slash-item${item.kind === "sub" ? " agent-slash-item-sub" : ""}${index === activeSlashIndex ? " selected" : ""}`}
                    onMouseDown={(event) => { event.preventDefault(); if (item.kind === "sub") completeSlash(item.command, item.sub); else completeSlash(item.command); }}
                  >
                    <span className="agent-slash-item-name">/{item.kind === "sub" ? `${item.command.name} ${item.sub.name}` : item.command.name}</span>
                    <span className="agent-slash-item-desc">{item.kind === "sub" ? t(item.sub.descriptionKey) : t(item.command.descriptionKey)}</span>
                    {item.kind === "sub" ? (item.sub.usageKey && <span className="agent-slash-item-usage">{t(item.sub.usageKey)}</span>) : (item.command.usageKey && <span className="agent-slash-item-usage">{t(item.command.usageKey)}</span>)}
                  </button>
                ))}
              </div>
            )}
            {pendingMemorySuggestions.length > 0 && (
              <div className="agent-memory-suggestions" role="status">
                {pendingMemorySuggestions.map((summary) => (
                  <div className="agent-memory-suggestion" key={summary}>
                    <span className="agent-memory-suggestion-label">{t("agent.memory.suggestion.title")}</span>
                    <span className="agent-memory-suggestion-text">{summary}</span>
                    <button
                      className="agent-memory-suggestion-save"
                      type="button"
                      onClick={() => {
                        void api.agentMemoryCreate({ summary })
                          .then(() => {
                            consumeAgentSuggestion(summary);
                            setPendingMemorySuggestions((suggestions) => suggestions.filter((item) => item !== summary));
                          })
                          .catch((error) => {
                            // Keep the chip so the user can retry; the error
                            // banner explains what went wrong.
                            setLoadError(error instanceof Error ? error.message : t("agent.error.saveMemory"));
                          });
                      }}
                    >{t("agent.memory.suggestion.save")}</button>
                    <button className="agent-memory-suggestion-dismiss" type="button" onClick={() => { consumeAgentSuggestion(summary); setPendingMemorySuggestions((suggestions) => suggestions.filter((item) => item !== summary)); }}>{t("agent.memory.suggestion.dismiss")}</button>
                  </div>
                ))}
              </div>
            )}
            <div className="agent-composer-bar">
              <div className="agent-composer-bar-left" ref={permissionRef}>
                <button className="agent-composer-attach" type="button" onClick={() => fileInputRef.current?.click()} disabled={streaming} aria-label={t("agent.composer.attachFile")} data-tooltip={t("agent.composer.attachFile")}><Plus size={16} /></button>
                {mode === "agent" && <button className="agent-composer-attach agent-composer-slash" type="button" onClick={() => { if (composer.trim()) return; setComposer("/"); setSlashDismissed(false); window.requestAnimationFrame(() => { const el = composerRef.current; if (el) { el.focus(); el.setSelectionRange(1, 1); } }); }} disabled={streaming || composer.trim().length > 0} aria-label={t("agent.commands.open")} data-tooltip={t("agent.commands.open")}><SquareSlash size={16} /></button>}
                {/* Permission control is mail-operation scoped, so it only
                    matters in the mail-assistant mode; plain chat hides it. */}
                {hasConfiguredProvider && mode === "agent" && (
                  <>
                    <button type="button" className={`agent-composer-permission${agentAccessLevel === "full-access" ? " full-access" : ""}`} onClick={() => setPermissionOpen((open) => !open)} aria-expanded={permissionOpen} aria-haspopup="menu" aria-controls="agent-permission-picker" aria-label={t("agent.permission.label")}>
                      {agentAccessLevel === "full-access" ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
                      <span>{currentPermissionLabel}</span>
                      <ChevronDown size={11} className={`agent-permission-chevron${permissionOpen ? " open" : ""}`} aria-hidden="true" />
                    </button>
                    {permissionPopover.mounted && (
                      <AgentPickerPopover id="agent-permission-picker" anchor="left" visible={permissionPopover.visible} label={t("agent.permission.label")}>
                        {permissionOptions.map((option, index) => {
                          const active = agentAccessLevel === option.level;
                          return (
                            <Fragment key={option.level}>
                              {index > 0 && <div className="agent-popover-divider" role="separator" />}
                              <button type="button" role="menuitemradio" aria-checked={active} className={`agent-popover-option${active ? " active" : ""}${option.level === "full-access" ? " danger" : ""}`} onClick={() => {
                                if (option.level === "full-access" && !active) {
                                  setPermissionOpen(false);
                                  setPendingAccessLevel("full-access");
                                  return;
                                }
                                setPermissionOpen(false);
                                if (!active) onAgentAccessLevelChange?.(option.level);
                              }}>
                                <span className="agent-popover-option-icon" aria-hidden="true">{option.icon}</span>
                                <span className="agent-popover-option-main">
                                  <strong>{option.label}</strong>
                                  <small>{option.hint}</small>
                                </span>
                                {active && <Check size={13} className="agent-popover-option-check" />}
                              </button>
                            </Fragment>
                          );
                        })}
                      </AgentPickerPopover>
                    )}
                  </>
                )}
              </div>
              <div className="agent-composer-bar-right">
                {(streaming || ghostConversationId === active?.id) && <LoaderCircle size={13} className="spin agent-composer-loading" aria-label={t("agent.composer.stop")} />}
                {hasConfiguredProvider && (
                  <div className="agent-composer-model-wrap" ref={modelPickerRef}>
                    <button type="button" className="agent-composer-model" onClick={() => setModelPickerOpen((open) => !open)} aria-expanded={modelPickerOpen} aria-haspopup="menu" aria-controls="agent-model-picker" aria-label={t("agent.provider.label")} disabled={streaming}>
                      <span>{selectedProvider ? selectedProvider.model : ""}</span>
                      <ChevronDown size={11} className={`agent-model-chevron${modelPickerOpen ? " open" : ""}`} aria-hidden="true" />
                    </button>
                    {modelPopover.mounted && (
                      <AgentPickerPopover id="agent-model-picker" anchor="right" visible={modelPopover.visible} label={t("agent.provider.label")}>
                        {configuredProviders.map((provider) => {
                          const isCurrent = selectedProvider?.id === provider.id;
                          return (
                            <button key={provider.id} type="button" role="menuitemradio" aria-checked={isCurrent} className={`agent-popover-option agent-model-option${isCurrent ? " active" : ""}`} onClick={() => {
                              setProviderId(provider.id);
                              // Pin the chosen model to the active conversation so switching
                              // back restores it; conversations without an explicit choice
                              // keep using the default provider.
                              if (!isCurrent && active) setConversationProviders((prev) => ({ ...prev, [active.id]: provider.id }));
                              setModelPickerOpen(false);
                            }}>
                              <span className="agent-model-option-name">{provider.model}</span>
                              {isCurrent && <Check size={13} className="agent-popover-option-check" />}
                            </button>
                          );
                        })}
                      </AgentPickerPopover>
                    )}
                  </div>
                )}
                {(streaming || ghostConversationId === active?.id) && <button className="agent-send-button stop" type="button" onClick={ghostConversationId === active?.id ? stopGhostRun : stopStreaming} aria-label={t("agent.composer.stop")} data-tooltip={t("agent.composer.stop")}><Square size={12} fill="currentColor" /></button>}
                <button className="agent-send-button" type="button" disabled={sendDisabled || ghostConversationId === active?.id} onClick={() => void sendMessage()} aria-label={t("agent.composer.send")} data-tooltip={t("agent.composer.send")}><ArrowUp size={16} strokeWidth={2.5} /></button>
              </div>
            </div>
          </div>
        </footer>
      </section>
      {latestCitations.length > 0 && (
        <div className={`agent-citations-sidebar ${citationsExpanded ? "expanded" : ""}`}>
          <button type="button" className="agent-citations-toggle" onClick={() => setCitationsExpanded((v) => !v)} aria-label={t("agent.citations.title")}>
            <FolderSearch size={15} />
            <span className="agent-citations-count">{latestCitations.length}</span>
          </button>
          <div className="agent-citations-panel">
            <div className="agent-citations-panel-header">
              <span>{t("agent.citations.title")}</span>
              <button type="button" onClick={() => setCitationsExpanded(false)} aria-label={t("agent.citations.close")}><X size={13} /></button>
            </div>
            {latestCitations.map((citation) => (
              <button key={citation.id} type="button" className="agent-citation-card" onClick={() => onOpenMessage(citation.messageId)}>
                <FolderSearch size={14} />
                <span>
                  <strong>{sourceLabel(citation)}</strong>
                  <small>{citation.excerpt}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <AgentProviderSettings
        open={agentSettingsPane !== null}
        pane={agentSettingsPane ?? "providers"}
        onPaneChange={setAgentSettingsPane}
        initialProviders={providers}
        initialDefaultProviderId={bootstrap?.defaultProviderId ?? null}
        onClose={() => setAgentSettingsPane(null)}
        onProvidersChanged={applyProviderList}
        restoreFocusRef={providerSettingsTriggerRef}
      />
      {deleteConfirm && (
        <div className="modal-backdrop confirmation-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDeleteConfirm(null)}>
          <section className="confirmation-card" role="alertdialog" aria-modal="true" aria-labelledby="agent-conversation-delete-title" aria-describedby="agent-conversation-delete-description" tabIndex={-1}>
            <span className="eyebrow">{t("agent.conversation.deleteEyebrow")}</span>
            <h3 id="agent-conversation-delete-title">{t("agent.conversation.deleteTitle")}</h3>
            <p id="agent-conversation-delete-description">{(() => {
              const titles = deleteConfirm
                .map((id) => conversations.find((item) => item.id === id)?.title?.trim() || t("agent.conversation.newTitle"))
                .filter(Boolean);
              if (titles.length > 3) {
                // A long list is summarised: the first three titles plus a
                // count of the rest, so the dialog stays scannable.
                return t("agent.conversation.deleteMany", {
                  shown: titles.slice(0, 3).map((title) => `「${title}」`).join("、"),
                  count: String(titles.length),
                });
              }
              return t("agent.conversation.deleteOne", { title: titles.map((title) => `「${title}」`).join("、") });
            })()}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus onClick={() => setDeleteConfirm(null)}>{t("common.cancel")}</button>
              <button className="secondary-button danger-button" type="button" onClick={() => void performDeleteConversations(deleteConfirm)}><Trash2 size={14} />{t("agent.conversation.delete")}</button>
            </div>
          </section>
        </div>
      )}
      {pendingAccessLevel && (
        <div className="modal-backdrop confirmation-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPendingAccessLevel(null)}>
          <section ref={accessConfirmRef} className="confirmation-card" role="alertdialog" aria-modal="true" aria-labelledby="agent-full-access-warning-title" aria-describedby="agent-full-access-warning-description" tabIndex={-1}>
            <span className="eyebrow">{t("agent.permission.warningEyebrow")}</span>
            <h3 id="agent-full-access-warning-title">{t("agent.permission.fullAccessWarningTitle")}</h3>
            <p id="agent-full-access-warning-description">{t("agent.permission.fullAccessWarningDescription")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus onClick={() => setPendingAccessLevel(null)}>{t("common.cancel")}</button>
              <button className="secondary-button danger-button" type="button" onClick={() => {
                const level = pendingAccessLevel;
                setPendingAccessLevel(null);
                onAgentAccessLevelChange?.(level);
              }}><Zap size={14} />{t("agent.permission.fullAccessWarningAction")}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
