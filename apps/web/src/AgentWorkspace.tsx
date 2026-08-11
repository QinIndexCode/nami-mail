import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Bot,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  Cloud,
  CircleAlert,
  ClipboardList,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderSearch,
  KeyRound,
  LoaderCircle,
  MessageCircle,
  MessageCirclePlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  PencilLine,
  Plus,
  Reply,
  Search,
  SquareSlash,
  ArrowUp,
  ChevronDown,
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
import { type AgentSlashCommand, type AgentSlashSubcommand } from "@nami/agent-contracts";
import { buildSlashMenu, slashCompletionText, slashKeepsMenuOpen, slashMenuActiveIndex } from "./slashMenu";
import { AgentMarkdown } from "./AgentMarkdown";
import { desktopBridge } from "./desktop";
import type {
  AgentBootstrap,
  AgentCitation,
  AgentConfirmation,
  AgentConversation,
  AgentConversationScope,
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
const SCRUBBER_MAX_SPEED = 16;
const SCRUBBER_MIN_SPEED = 2;
// Maximum blur (px) applied to bars as they approach the track edges.
const SCRUBBER_BLUR_MAX = 1.5;

// Edge-zone scroll speed eases toward the edge: the closer the cursor gets to
// the boundary, the faster the bar group scrolls, with a small floor so the
// motion is always perceptible once the zone is entered.
function scrubberEdgeSpeed(distanceToEdge: number): number {
  const factor = Math.pow(1 - Math.min(1, distanceToEdge / SCRUBBER_EDGE_ZONE), 2);
  return Math.max(SCRUBBER_MIN_SPEED, SCRUBBER_MAX_SPEED * factor);
}

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
function useMountedVisible(open: boolean, duration = 160): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : duration);
    return () => window.clearTimeout(timer);
  }, [open, duration]);
  return { mounted, visible };
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

function applyRevokedMarks(conversation: AgentConversation): AgentConversation {
  const revokedIds = readRevokedIds(conversation.id);
  if (revokedIds.size === 0) return conversation;
  return {
    ...conversation,
    messages: conversation.messages.map((message) => (revokedIds.has(message.id) ? { ...message, revoked: true } : message)),
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
      return { ...message, citations: [...message.citations, event.citation] };
    case "tool": {
      const previous = message.toolActivities.filter((activity) => activity.id !== event.activity.id);
      return { ...message, toolActivities: [...previous, event.activity] };
    }
    case "confirmation":
      return { ...message, confirmation: event.confirmation, toolActivities: message.toolActivities.map((activity) => activity.state === "awaiting_confirmation" ? activity : activity) };
    case "error":
      return { ...message, state: "error", error: event.error };
    case "completed":
      return { ...message, state: event.reason === "error" ? "error" : "complete" };
    default:
      return message;
  }
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
    ? activity.error?.code?.startsWith("CONFIRMATION_")
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
        <span>{t("agent.tool.summary", { count: activities.length })}</span>
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
  remainingMs,
}: {
  confirmation: AgentConfirmation;
  desktopConfirmationAvailable: boolean;
  resolutionError?: string;
  /** Local decision handler (demo mode) — real builds resolve through the desktop bridge. */
  onDecision?: (decision: "approve" | "reject") => void;
  /** Milliseconds until the confirmation expires (0 when unknown/expired). */
  remainingMs?: number;
}) {
  const { locale, t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  const decisionEnabled = Boolean(onDecision);
  const resolve = (decision: "approve" | "reject") => {
    if (leaving) return;
    setLeaving(true);
    // Let the collapse animation finish before the card unmounts.
    window.setTimeout(() => onDecision?.(decision), 260);
  };
  return (
    <section
      className={`agent-confirmation-card${leaving ? " leaving" : ""}`}
      aria-label={confirmation.title}
      data-nami-agent-confirmation-card
      data-nami-agent-confirmation-id={confirmation.id}
    >
      <div className="agent-confirmation-heading"><ShieldAlert size={17} /><span><strong>{confirmation.title}</strong><small>{confirmation.summary}</small></span><small className="agent-confirmation-expiry">{remainingMs !== undefined && remainingMs > 0
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

type AgentMessageRowProps = {
  message: AgentMessage;
  /** Whether a newer user turn follows this message (supersedes its warnings). */
  superseded: boolean;
  /** Live provider status text (e.g. "retrying") shown in the thinking line. */
  statusMessage?: string | null;
  locale: string;
  t: Translate;
  onOpenAttachment: (path?: string) => void;
  onCopy: (content: string) => void;
  onRevoke: (messageId: string) => void;
  onRestore: (messageId: string) => void;
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
  onCopy,
  onRevoke,
  onRestore,
  onRetry,
  onUserMessageRef,
}: AgentMessageRowProps) {
  const userMessageRef = useCallback((node: HTMLElement | null) => {
    onUserMessageRef(message.id, node);
  }, [message.id, onUserMessageRef]);
  return (
    <article
      className={`agent-message ${message.role} ${message.state === "streaming" ? "streaming" : ""}`}
      ref={message.role === "user" ? userMessageRef : undefined}
    >
      {message.revoked ? (
        <div className="agent-message-revoked">
          <span className="agent-message-revoked-badge">{t("agent.message.revoked")}</span>
          <button type="button" className="agent-corner-button resend" onClick={() => onRestore(message.id)} data-tooltip={message.role === "user" ? t("agent.message.resend") : t("agent.message.restore")} aria-label={message.role === "user" ? t("agent.message.resend") : t("agent.message.restore")}><PencilLine size={12} /></button>
        </div>
      ) : (
        <>
          {message.quote && <div className="agent-message-quote"><span className="agent-quote-mark" aria-hidden="true">"</span><span className="agent-quote-text">{truncateForPreview(message.quote)}</span><span className="agent-quote-mark" aria-hidden="true">"</span></div>}
          {message.content ? <AgentMarkdown content={message.content} /> : message.state === "streaming" && <div className="agent-thinking"><LoaderCircle className="spin" size={16} />{statusMessage || t("agent.message.thinking")}</div>}
          {message.attachments && message.attachments.length > 0 && <div className="agent-message-attachments">{message.attachments.map((attachment, index) => <button key={`${attachment.name}-${index}`} type="button" className="agent-message-attachment" onClick={() => onOpenAttachment(attachment.path)} data-tooltip={attachment.path ?? attachment.name}><FileText size={15} /><span>{attachment.name}</span></button>)}</div>}
          {message.toolActivities.length > 0 && <AgentToolList activities={message.toolActivities} superseded={superseded} />}
          {message.error && <div className="agent-message-error"><CircleAlert size={15} /><span>{message.error.message}{message.error.suggestion ? ` ${message.error.suggestion}` : ""}</span>{message.error.retryable && <button type="button" onClick={onRetry}>{t("agent.message.retry")}</button>}</div>}
        </>
      )}
      <div className="agent-message-meta">{message.role === "system" && <span className="agent-message-role">{t("agent.message.system")}</span>}<time>{shortDate(message.createdAt, locale)}</time><span className="agent-message-actions">{message.content && <button type="button" className="agent-corner-button" onClick={() => void onCopy(message.content)} aria-label={t("agent.message.copy")} data-tooltip={t("agent.message.copy")}><Copy size={12} /></button>}{message.role === "user" && <AgentRecallButton disabled={!message.content || message.state === "streaming"} onRevoke={() => onRevoke(message.id)} label={t("agent.message.revoke")} confirmLabel={t("agent.message.revokeConfirm")} />}</span></div>
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
  const configured = providers.filter((provider) => provider.configured);
  return configured.find((provider) => provider.id === defaultProviderId)?.id ?? configured[0]?.id ?? "";
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
  initialProviders,
  initialDefaultProviderId,
  onClose,
  onOpenMcpServers,
  onProvidersChanged,
  restoreFocusRef,
}: {
  open: boolean;
  initialProviders: AgentProviderSummary[];
  initialDefaultProviderId: string | null;
  onClose: () => void;
  onOpenMcpServers?: () => void;
  onProvidersChanged: (providers: AgentProviderList) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const [providers, setProviders] = useState<AgentProviderSummary[]>(initialProviders);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(initialDefaultProviderId);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => providerFormFor(null, initialDefaultProviderId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const selectedProviderIdRef = useRef<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const isDefaultProvider = Boolean(selectedProvider && selectedProvider.id === defaultProviderId);
  const isOllama = form.kind === "ollama";
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
    setDeletePending(false);
    setKeyVisible(false);
    setNotice(null);
  }, [defaultProviderId]);

  const applyProviderList = useCallback((snapshot: AgentProviderList, preferredProviderId: string | null = null) => {
    setProviders(snapshot.items);
    setDefaultProviderId(snapshot.defaultProviderId);
    onProvidersChanged(snapshot);
    const selected = (preferredProviderId ? snapshot.items.find((provider) => provider.id === preferredProviderId) : undefined)
      ?? snapshot.items.find((provider) => provider.id === selectedProviderIdRef.current)
      ?? snapshot.items.find((provider) => provider.id === snapshot.defaultProviderId)
      ?? snapshot.items[0]
      ?? null;
    setSelectedProviderId(selected?.id ?? null);
    setForm(providerFormFor(selected, snapshot.defaultProviderId));
    setDeletePending(false);
    setKeyVisible(false);
  }, [onProvidersChanged]);

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
    setProviders(initialProviders);
    setDefaultProviderId(initialDefaultProviderId);
    setSelectedProviderId(null);
    setForm(providerFormFor(null, initialDefaultProviderId));
    setLoadError(null);
    setNotice(null);
    setDeletePending(false);
    void refreshProviders();
  }, [open]);

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
    setDeletePending(false);
  };

  const updateKind = (kind: AgentProviderKind) => {
    setForm((current) => ({
      ...current,
      kind,
      endpoint: !current.endpoint.trim() ? providerKindMetadata[kind].endpointSuggestion : current.endpoint,
      allowCloudMailContent: kind === "ollama" ? false : current.allowCloudMailContent,
    }));
    setNotice(null);
    setDeletePending(false);
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
      allowCloudMailContent: isOllama ? false : form.allowCloudMailContent,
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

  const deleteProvider = async () => {
    if (!selectedProvider || saving) return;
    if (!deletePending) {
      setDeletePending(true);
      return;
    }
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    try {
      await api.deleteAgentProvider(selectedProvider.id);
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
          <div><span className="eyebrow">NAMI AGENT</span><h2>{t("agent.providers.title")}</h2><p>{t("agent.providers.description")}</p></div>
          <div className="agent-provider-settings-actions">
            {onOpenMcpServers && <button className="agent-mcp-switch-button" type="button" disabled={saving} data-tooltip={t("agent.mcpServers.openHint")} onClick={onOpenMcpServers}><Server size={14} />{t("agent.mcpServers.open")}</button>}
            <button className="icon-button" type="button" data-dialog-initial-focus aria-label={t("agent.providers.close")} data-tooltip={t("agent.providers.close")} disabled={saving} onClick={requestClose}><X size={18} /></button>
          </div>
        </header>

        <div className="agent-provider-settings-body">
          <section className="agent-provider-catalog" aria-label={t("agent.providers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.providers.available")}</span><button className="agent-provider-new" type="button" disabled={saving} onClick={() => selectProvider(null)}><Plus size={15} />{t("agent.providers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.providers.loading")}</div>}
            {!loading && !providers.length && <div className="agent-provider-empty"><Server size={18} /><strong>{t("agent.providers.empty")}</strong><small>{t("agent.providers.emptyDescription")}</small></div>}
            <div className="agent-provider-list">
              {providers.map((provider) => {
                const active = provider.id === selectedProviderId;
                const state = providerVisualState(provider);
                return (
                  <button key={provider.id} className={`agent-provider-list-item ${active ? "active" : ""}`} type="button" aria-pressed={active} disabled={saving} onClick={() => selectProvider(provider)}>
                    <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                    <span><strong>{provider.label}</strong><small>{provider.model}</small><span className="agent-provider-list-meta">{provider.id === defaultProviderId && <em className="default">{t("agent.providers.status.default")}</em>}<em className={state}>{t(`agent.providers.status.${state}`)}</em></span></span>
                    {provider.cloud ? <Cloud size={14} aria-label={t("agent.providers.status.cloud")} /> : <Server size={14} aria-label={t("agent.providers.status.local")} />}
                  </button>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
            <div className="agent-provider-form-heading"><div><span className="eyebrow">{selectedProvider ? t("agent.providers.form.editEyebrow") : t("agent.providers.form.newEyebrow")}</span><h3>{selectedProvider ? t("agent.providers.form.editTitle") : t("agent.providers.form.newTitle")}</h3></div>{selectedProvider && <span className={`agent-provider-form-status ${providerVisualState(selectedProvider)}`}>{providerVisualState(selectedProvider) === "verified" ? <Check size={14} /> : <CircleAlert size={14} />}{t(`agent.providers.status.${providerVisualState(selectedProvider)}`)}</span>}</div>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={saving} onClick={() => void refreshProviders(selectedProviderId)}>{t("agent.providers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}

            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.kind")}</strong><small>{t("agent.providers.fields.kindHint")}</small></span><ThemedSelect id="agent-provider-kind" value={form.kind} onValueChange={(value) => updateKind(value as AgentProviderKind)} disabled={saving} aria-label={t("agent.providers.fields.kind")}><option value="openai-compatible">{t("agent.providers.kind.openaiCompatible")}</option><option value="ollama">{t("agent.providers.kind.ollama")}</option><option value="anthropic">{t("agent.providers.kind.anthropic")}</option><option value="gemini">{t("agent.providers.kind.gemini")}</option><option value="openai-responses">{t("agent.providers.kind.openaiResponses")}</option></ThemedSelect></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.label")}</strong><small>{t("agent.providers.fields.labelHint")}</small></span><input value={form.label} maxLength={128} disabled={saving} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.endpoint")}</strong><small>{t(kindMeta.endpointHintKey)}</small></span><input value={form.endpoint} placeholder={kindMeta.endpointSuggestion || t("agent.providers.fields.endpointPlaceholder")} disabled={saving} onChange={(event) => updateForm("endpoint", event.target.value)} autoComplete="url" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.model")}</strong><small>{t("agent.providers.fields.modelHint")}</small></span><input value={form.model} placeholder={kindMeta.modelPlaceholder} maxLength={256} disabled={saving} onChange={(event) => updateForm("model", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            {embeddingCapable && <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.embeddingModel")}</strong><small>{t("agent.providers.fields.embeddingModelHint")}</small></span><input value={form.embeddingModel} placeholder={kindMeta.embeddingModelPlaceholder} maxLength={256} disabled={saving} onChange={(event) => updateForm("embeddingModel", event.target.value)} autoComplete="off" spellCheck={false} /></label>}
            <label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.providers.fields.timeout")}</strong><small>{t("agent.providers.fields.timeoutHint")}</small></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={saving} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.providers.fields.apiKey")}</strong><small>{selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")}</small></span><div className="agent-provider-secret"><input type={keyVisible ? "text" : "password"} value={form.apiKey} disabled={saving || form.clearApiKey} onChange={(event) => updateForm("apiKey", event.target.value)} placeholder={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyKeep") : t("agent.providers.fields.apiKeyPlaceholder")} autoComplete="new-password" spellCheck={false} /><button className="icon-button" type="button" disabled={saving || form.clearApiKey} aria-label={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} data-tooltip={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} onClick={() => setKeyVisible((visible) => !visible)}>{keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{selectedProvider?.apiKeyConfigured && <button className={`agent-provider-inline-toggle ${form.clearApiKey ? "active" : ""}`} type="button" role="switch" aria-checked={form.clearApiKey} disabled={saving || Boolean(form.apiKey)} onClick={() => updateForm("clearApiKey", !form.clearApiKey)}><span aria-hidden="true" /><span>{t("agent.providers.fields.clearApiKey")}</span></button>}</div>
            <button className={`agent-provider-toggle-row ${form.allowCloudMailContent ? "active" : ""}`} type="button" role="switch" aria-checked={form.allowCloudMailContent} disabled={saving || isOllama} onClick={() => updateForm("allowCloudMailContent", !form.allowCloudMailContent)}><span><strong>{t("agent.providers.cloud.title")}</strong><small>{isOllama ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")}</small></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>
            <button className={`agent-provider-toggle-row ${form.makeDefault ? "active" : ""}`} type="button" role="switch" aria-checked={form.makeDefault} disabled={saving || isDefaultProvider} onClick={() => updateForm("makeDefault", !form.makeDefault)}><span><strong>{t("agent.providers.default.title")}</strong><small>{isDefaultProvider ? t("agent.providers.default.current") : t("agent.providers.default.description")}</small></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions"><button className="primary-button" type="submit" disabled={saving || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{saving ? t("agent.providers.savingAndChecking") : t("agent.providers.save")}</button>{selectedProvider && <button className={`secondary-button danger-button ${deletePending ? "agent-provider-delete-pending" : ""}`} type="button" disabled={saving} onClick={() => void deleteProvider()}><Trash2 size={15} />{deletePending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")}</button>}</div>
            {deletePending && <p className="agent-provider-delete-note">{t("agent.providers.deletePrompt")}</p>}
          </form>
        </div>
      </aside>
    </div>
  );
}

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

function AgentMcpServerSettings({
  open,
  onClose,
  onOpenProviders,
  restoreFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  onOpenProviders?: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
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
    if (!open) return;
    setSelectedServerId(null);
    setForm(mcpServerFormFor(null));
    setEnvRows([{ key: "", value: "" }]);
    setLoadError(null);
    setNotice(null);
    setDeletePending(false);
    void refreshServers();
  }, [open, refreshServers]);

  const { closing, requestClose } = useDismissTransition(() => {
    onClose();
  });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving || checking) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".select-control")?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [requestClose, open, saving, checking]);

  useDialogFocus(open || closing, dialogRef, { restoreFocusRef });

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

  if (!open && !closing) return null;

  const busy = saving || checking;
  const selectedState = selectedServer ? mcpServerVisualState(selectedServer) : "enabled";
  const selectedStateLabel = selectedServer ? t(`agent.mcpServers.status.${selectedState}`) : "";

  return (
    <div
      className={`agent-provider-settings-scrim${closing ? " closing" : ""}`}
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) requestClose();
      }}
    >
      <aside ref={dialogRef} className={`agent-provider-settings${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={t("agent.mcpServers.title")} tabIndex={-1}>
        <header className="agent-provider-settings-header">
          <div><span className="eyebrow">NAMI AGENT</span><h2>{t("agent.mcpServers.title")}</h2><p>{t("agent.mcpServers.description")}</p></div>
          <div className="agent-provider-settings-actions">
            {onOpenProviders && <button className="agent-mcp-switch-button" type="button" disabled={busy} onClick={onOpenProviders}><KeyRound size={14} />{t("agent.providers.open")}</button>}
            <button className="icon-button" type="button" data-dialog-initial-focus aria-label={t("agent.mcpServers.close")} data-tooltip={t("agent.mcpServers.close")} disabled={busy} onClick={requestClose}><X size={18} /></button>
          </div>
        </header>

        <div className="agent-provider-settings-body">
          <section className="agent-provider-catalog" aria-label={t("agent.mcpServers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.mcpServers.available")}</span><button className="agent-provider-new" type="button" disabled={busy} onClick={() => selectServer(null)}><Plus size={15} />{t("agent.mcpServers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.mcpServers.loading")}</div>}
            {!loading && !servers.length && <div className="agent-provider-empty"><Server size={18} /><strong>{t("agent.mcpServers.empty")}</strong><small>{t("agent.mcpServers.emptyDescription")}</small></div>}
            <div className="agent-provider-list">
              {servers.map((server) => {
                const active = server.id === selectedServerId;
                const state = mcpServerVisualState(server);
                return (
                  <button key={server.id} className={`agent-provider-list-item ${active ? "active" : ""}`} type="button" aria-pressed={active} disabled={busy} onClick={() => selectServer(server)}>
                    <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                    <span>
                      <strong>{server.label}</strong>
                      <small>{server.command}</small>
                      <span className="agent-provider-list-meta"><em className={state}>{t(`agent.mcpServers.status.${state}`)}</em>{server.toolCount !== undefined && <em className="tools">{t("agent.mcpServers.status.tools", { count: server.toolCount })}</em>}</span>
                    </span>
                    <Server size={14} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveServer(); }}>
            <div className="agent-provider-form-heading"><div><span className="eyebrow">{selectedServer ? t("agent.mcpServers.form.editEyebrow") : t("agent.mcpServers.form.newEyebrow")}</span><h3>{selectedServer ? t("agent.mcpServers.form.editTitle") : t("agent.mcpServers.form.newTitle")}</h3></div>{selectedServer && <span className={`agent-provider-form-status ${selectedState}`}>{selectedState === "checked" ? <Check size={14} /> : <CircleAlert size={14} />}{selectedStateLabel}</span>}</div>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={busy} onClick={() => void refreshServers(selectedServerId)}>{t("agent.mcpServers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}

            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.label")}</strong><small>{t("agent.mcpServers.fields.labelHint")}</small></span><input value={form.label} maxLength={128} disabled={busy} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.command")}</strong><small>{t("agent.mcpServers.fields.commandHint")}</small></span><input value={form.command} placeholder={t("agent.mcpServers.fields.commandPlaceholder")} maxLength={1024} disabled={busy} onChange={(event) => updateForm("command", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.args")}</strong><small>{t("agent.mcpServers.fields.argsHint")}</small></span><textarea className="agent-mcp-args-input" value={form.argsText} placeholder={t("agent.mcpServers.fields.argsPlaceholder")} rows={3} disabled={busy} onChange={(event) => updateForm("argsText", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.env")}</strong><small>{t("agent.mcpServers.fields.envHint")}</small></span>
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
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.cwd")}</strong><small>{t("agent.mcpServers.fields.cwdHint")}</small></span><input value={form.cwd} maxLength={2048} disabled={busy} onChange={(event) => updateForm("cwd", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.mcpServers.fields.timeout")}</strong><small>{t("agent.mcpServers.fields.timeoutHint")}</small></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={busy} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <button className={`agent-provider-toggle-row ${form.enabled ? "active" : ""}`} type="button" role="switch" aria-checked={form.enabled} disabled={busy} onClick={() => updateForm("enabled", !form.enabled)}><span><strong>{t("agent.mcpServers.fields.enabled")}</strong><small>{form.enabled ? t("agent.mcpServers.enabled.active") : t("agent.mcpServers.enabled.disabled")}</small></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions">
              <button className="primary-button" type="submit" disabled={busy || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Server size={15} />}{saving ? t("agent.mcpServers.savingAndChecking") : t("agent.mcpServers.save")}</button>
              {selectedServer && <button className="secondary-button" type="button" disabled={busy || Boolean(validationMessage)} onClick={() => void checkServer()}>{checking ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{checking ? t("agent.mcpServers.checking") : t("agent.mcpServers.check")}</button>}
              {selectedServer && <button className={`secondary-button danger-button ${deletePending ? "agent-provider-delete-pending" : ""}`} type="button" disabled={busy} onClick={() => void deleteServer()}><Trash2 size={15} />{deletePending ? t("agent.mcpServers.deleteConfirm") : t("agent.mcpServers.delete")}</button>}
            </div>
            {deletePending && <p className="agent-provider-delete-note">{t("agent.mcpServers.deletePrompt")}</p>}
          </form>
        </div>
      </aside>
    </div>
  );
}

export default function AgentWorkspace({ accounts, messages, currentMessage, onClose, onOpenMessage, restoreFocusRef, demoMode = false, providerSettingsRequestId = 0, preloadedBootstrap, agentAccessLevel = "send-confirmed", onAgentAccessLevelChange }: AgentWorkspaceProps) {
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
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
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
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [mcpServerSettingsOpen, setMcpServerSettingsOpen] = useState(false);
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  const [confirmationErrors, setConfirmationErrors] = useState<Record<string, string>>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<ProcessedFile[]>([]);
  const [processingFileName, setProcessingFileName] = useState<string | null>(null);
  const [citationsExpanded, setCitationsExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [quoteContext, setQuoteContext] = useState<string | null>(null);
  // Content coordinates of each user message, used only as the jump target
  // when a scrubber bar is clicked. Bar layout itself is a fixed-interval
  // group (see SCRUBBER_* constants), independent of these positions.
  const [userMarkerPositions, setUserMarkerPositions] = useState<number[]>([]);
  const [hoveredUserIndex, setHoveredUserIndex] = useState<number | null>(null);
  const userMessageElsRef = useRef<Map<string, HTMLElement>>(new Map());
  // Auto-scroll while the cursor sits in the top/bottom edge zone: the
  // direction and per-frame speed are read from refs so a rAF loop keeps
  // running without restarting on every mouse move; the boolean state only
  // controls whether the loop is active.
  const [scrubberScrolling, setScrubberScrolling] = useState(false);
  const scrubberDirectionRef = useRef<-1 | 1>(1);
  const scrubberSpeedRef = useRef(0);
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
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
  const registerUserMessageEl = useCallback((messageId: string, node: HTMLElement | null) => {
    if (node) userMessageElsRef.current.set(messageId, node);
    else userMessageElsRef.current.delete(messageId);
  }, []);
  const retryLastUserTurn = useCallback(() => {
    const target = activeMessagesRef.current?.slice().reverse().find((item) => item.role === "user");
    setComposer(target?.content ?? "");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  useDialogFocus(true, workspaceRef, { restoreFocusRef, suspended: providerSettingsOpen || mcpServerSettingsOpen || Boolean(pendingAccessLevel) });
  useDialogFocus(Boolean(pendingAccessLevel), accessConfirmRef, { restoreFocusRef: workspaceRef });

  const scope = useMemo(() => agentScopeFor(scopeMode, currentMessage, accounts), [accounts, currentMessage, scopeMode]);
  const providers = bootstrap?.providers ?? [];
  const configuredProviders = useMemo(() => providers.filter((provider) => provider.configured), [providers]);
  const selectedProvider = configuredProviders.find((provider) => provider.id === providerId)
    ?? configuredProviders.find((provider) => provider.id === bootstrap?.defaultProviderId)
    ?? configuredProviders[0];
  const hasConfiguredProvider = Boolean(selectedProvider);
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
      // newest one) in the background.
      const lastActiveId = readLastActiveConversationId();
      const initialTarget = value.conversations.some((item) => item.id === lastActiveId)
        ? lastActiveId!
        : value.conversations[0]?.id;
      if (initialTarget) {
        try {
          const conversation = await api.agentConversation(initialTarget);
          setActive(applyRevokedMarks(purgeStaleErrors(conversation)));
          setProviderId((current) => value.providers.some((provider) => provider.id === conversation.providerId && provider.configured)
            ? conversation.providerId
            : current || configuredProviderId(value.providers, value.defaultProviderId));
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
  // outside them.
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
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [permissionOpen, modelPickerOpen]);
  useEffect(() => {
    if (demoMode || providerSettingsRequestId === 0) return;
    setProviderSettingsOpen(true);
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
    () => active?.messages.filter((message) => message.role === "user") ?? [],
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
    const el = transcriptRef.current;
    if (!el || userMessages.length === 0) {
      setUserMarkerPositions([]);
      return;
    }
    const containerRect = el.getBoundingClientRect();
    setUserMarkerPositions(userMessages.map((message) => {
      const node = userMessageElsRef.current.get(message.id);
      if (!node) return 0;
      // Content coordinate: viewport offset plus the current scroll position,
      // so bars stay aligned regardless of where the transcript is scrolled.
      return node.getBoundingClientRect().top - containerRect.top + el.scrollTop;
    }));
  }, [userMessageIdsKey, userMessages.length]);
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
    setHoveredUserIndex(nearest);
    // Auto-scroll only once the group overflows the track: hovering the
    // top/bottom edge zone scrolls the BAR GROUP (not the transcript) faster
    // the closer the cursor gets to the edge. Leaving the scrubber stops it.
    if (totalHeight > track.height) {
      if (y <= SCRUBBER_EDGE_ZONE) {
        scrubberDirectionRef.current = 1;
        scrubberSpeedRef.current = scrubberEdgeSpeed(y);
        setScrubberScrolling(true);
        return;
      }
      if (y >= track.height - SCRUBBER_EDGE_ZONE) {
        scrubberDirectionRef.current = -1;
        scrubberSpeedRef.current = scrubberEdgeSpeed(track.height - y);
        setScrubberScrolling(true);
        return;
      }
    }
    setScrubberScrolling(false);
  }, [userMessages.length]);
  // Drives the auto-scroll loop while the cursor stays in the edge zone. Each
  // frame the viewport offset moves toward the bound the cursor points at;
  // reaching a bound stops the loop.
  useEffect(() => {
    if (!scrubberScrolling) return;
    const track = scrubberTrackRef.current;
    if (!track || userMessages.length === 0) return;
    const totalHeight = (userMessages.length - 1) * SCRUBBER_BAR_GAP;
    const maxOffset = totalHeight - track.clientHeight;
    let raf = 0;
    const tick = () => {
      const current = scrubberViewportRef.current;
      if (current === null) return;
      const next = Math.min(0, Math.max(-maxOffset, current + scrubberDirectionRef.current * scrubberSpeedRef.current));
      if (next === current) {
        setScrubberScrolling(false);
        return;
      }
      scrubberViewportRef.current = next;
      setScrubberViewport(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scrubberScrolling, userMessages.length]);
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
    if (hovered === null) return 3;
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
  }, [scope.accountIds]);

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const openAttachmentFolder = useCallback((path?: string) => {
    if (!path) return;
    void desktopBridge()?.showItemInFolder?.(path);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);
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
  // A conversation whose newest turn has no assistant reply yet may still be
  // finishing on the server (closing the panel does not cancel the run). Poll
  // for the completed reply and fold it into the transcript. The polling
  // stops as soon as the local transcript moves on (new send, conversation
  // switch) or the attempt budget runs out.
  useEffect(() => {
    if (demoMode || streaming || !active || !lastMessageIsUnanswered(active)) return;
    const targetId = active.id;
    const pendingUserMessageId = active.messages[active.messages.length - 1].id;
    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      attempts += 1;
      try {
        const fresh = await api.agentConversation(targetId);
        if (stopped) return;
        const freshLast = fresh.messages[fresh.messages.length - 1];
        if (freshLast && freshLast.role === "assistant") {
          const next = applyRevokedMarks(purgeStaleErrors(fresh));
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingUserMessageId
            ? next
            : current);
          void refreshConversations(conversationSearch);
          return;
        }
      } catch {
        // Transient failure — keep polling until the attempt budget runs out.
      }
      if (attempts < 240) {
        timer = setTimeout(() => void tick(), 2_000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, applyRevokedMarks, conversationSearch, demoMode, purgeStaleErrors, refreshConversations, streaming]);
  // The message-scoped modes (selected_account / current_message) derive their
  // accountIds and messageIds from the currently selected message.
  // When that message is cleared, fall back to all_accounts so the composer
  // does not silently operate on a stale or empty scope.
  useEffect(() => {
    if (!currentMessage && scopeMode !== "all_accounts") {
      setScopeMode("all_accounts");
    }
  }, [currentMessage, scopeMode]);

  const selectConversation = useCallback(async (id: string) => {
    if (streaming) return;
    try {
      setLoadError(null);
      // Memory suggestions belong to the reply that produced them; switching
      // conversations discards any that are still undecided.
      setPendingMemorySuggestions([]);
      const conversation = await api.agentConversation(id);
      setActive(applyRevokedMarks(purgeStaleErrors(conversation)));
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
      setLoadError(error instanceof Error ? error.message : t("agent.error.loadConversation"));
    }
  }, [bootstrap?.defaultProviderId, conversationProviders, providers, streaming, t]);

  const createConversation = useCallback(async () => {
    if (streaming) return;
    if (!selectedProvider) {
      setProviderSettingsOpen(true);
      return;
    }
    // Don't create the conversation record yet — defer until the first message
    // is sent. This avoids empty conversations piling up in the history list
    // and lets the welcome screen (with the animated logo) show.
    setActive(null);
    setComposer("");
    setAttachedFiles([]);
    setRenaming(false);
    setLoadError(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [selectedProvider, streaming]);

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

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await api.deleteAgentConversation(id);
      const next = conversations.filter((conversation) => conversation.id !== id);
      setConversations(next);
      setPendingDeleteId(null);
      if (active?.id === id) {
        setActive(null);
        if (next[0]) void selectConversation(next[0].id);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.deleteConversation"));
    }
  }, [active?.id, conversations, selectConversation, t]);

  const mutateAssistant = useCallback((messageId: string, event: AgentStreamEvent) => {
    setActive((current) => {
      if (!current) return current;
      return {
        ...current,
        messages: current.messages.map((message) => message.id === messageId ? messageWithEvent(message, event) : message),
      };
    });
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
    if (!userText || streaming) return;
    if (!selectedProvider) {
      setProviderSettingsOpen(true);
      return;
    }
    const files = attachedFiles;
    // Quote context from "Follow up" — sent to the LLM as truncated context,
    // the user only sees their own question in the transcript.
    const quote = quoteContext;
    const truncatedQuote = quote ? truncateForContext(quote) : undefined;
    // File content is sent to the LLM for analysis, but not stored in the
    // user-visible message content. The user sees file cards instead.
    const apiContent = files.length > 0
      ? files.map((f) => `[file: ${f.name}${f.truncated ? " (truncated)" : ""}]\n${f.text}\n[/file]`).join("\n\n") + `\n\n${userText}`
      : userText;
    let conversation = active;
    if (!conversation || !sameAgentScope(conversation.scope, scope)) {
      try {
        conversation = await api.createAgentConversation({ providerId: selectedProvider.id, scope });
        setActive(conversation);
        setConversations((items) => [{ id: conversation!.id, title: conversation!.title, preview: conversation!.preview, updatedAt: conversation!.updatedAt }, ...items.filter((item) => item.id !== conversation!.id)]);
      } catch (error) {
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
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.streamAgentMessage(conversation.id, {
        content: apiContent,
        providerId: selectedProvider.id,
        mode,
        scope,
        context: {
          ...(currentMessage ? { currentMessageId: currentMessage.id } : {}),
        },
        ...(truncatedQuote ? { quote: truncatedQuote } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }, (event) => {
        mutateAssistant(assistantMessage.id, event);
        if (event.type === "status" && event.message) {
          setStreamStatus(event.message);
        } else if (event.type === "completed") {
          setStreamStatus(null);
        }
        if (event.type === "memory_suggestion") {
          setPendingMemorySuggestions((suggestions) => (suggestions.includes(event.summary) ? suggestions : [...suggestions, event.summary]));
        }
      }, controller.signal);
// A successful turn clears stale failure rows — both the one the retry
// targeted and any others left behind — so the transcript stops showing
      // outdated errors once the conversation moves on.
      setActive((current) => current ? {
        ...current,
        messages: current.messages
          .filter((item) => !(item.error && item.content === ""))
          .map((item) => (item.error ? { ...item, error: undefined } : item)),
      } : current);
      await refreshConversations(conversationSearch);
    } catch (error) {
      if (controller.signal.aborted) {
        mutateAssistant(assistantMessage.id, { type: "completed", reason: "cancelled" });
      } else {
        const code = error instanceof ApiError ? error.code ?? "agent_request_failed" : "agent_request_failed";
        const message = code === "agent_stream_unavailable"
          ? t("agent.error.streamUnavailable")
          : code === "agent_stream_invalid"
            ? t("agent.error.streamInvalid")
            : error instanceof Error ? error.message : t("agent.error.stream");
        mutateAssistant(assistantMessage.id, { type: "error", error: { code, message, retryable: true } });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  }, [active, attachedFiles, composer, conversationSearch, currentMessage, mode, mutateAssistant, quoteContext, refreshConversations, scope, selectedProvider, streaming, t]);

  const stopStreaming = useCallback(() => {
    const conversationId = active?.id;
    abortRef.current?.abort();
    if (conversationId) void api.cancelAgentRun(conversationId).catch(() => undefined);
  }, [active?.id]);

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

  const copyText = useCallback(async (content: string) => {
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
  }, []);

  const scopeOptions: Array<{ mode: AgentScopeMode; label: string; title: string; disabled?: boolean }> = [
    { mode: "all_accounts", label: t("agent.scope.all"), title: t("agent.scope.all.tooltip") },
    { mode: "selected_account", label: t("agent.scope.account"), title: t("agent.scope.account.tooltip"), disabled: !currentMessage },
    { mode: "current_message", label: t("agent.scope.message"), title: t("agent.scope.message.tooltip"), disabled: !currentMessage },
  ];
  const permissionOptions: Array<{ level: AgentAccessLevel; label: string; detail: string; features: string[]; icon: ReactNode }> = [
    { level: "read-only", label: t("agent.permission.readOnly"), detail: t("agent.permission.readOnly.detail"), features: [t("agent.permission.readOnly.feature1"), t("agent.permission.readOnly.feature2"), t("agent.permission.readOnly.feature3")], icon: <Eye size={12} /> },
    { level: "send-confirmed", label: t("agent.permission.confirmed"), detail: t("agent.permission.confirmed.detail"), features: [t("agent.permission.confirmed.feature1"), t("agent.permission.confirmed.feature2"), t("agent.permission.confirmed.feature3")], icon: <ShieldCheck size={12} /> },
    { level: "full-access", label: t("agent.permission.fullAccess"), detail: t("agent.permission.fullAccess.detail"), features: [t("agent.permission.fullAccess.feature1"), t("agent.permission.fullAccess.feature2"), t("agent.permission.fullAccess.feature3")], icon: <Zap size={12} /> },
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
  const composerDisabled = streaming || !hasConfiguredProvider || (!demoMode && !bootstrap?.enabled);
  // Sending is never available in demo mode (there is no Agent backend).
  const sendDisabled = demoMode || !composer.trim() || composerDisabled || (mode === "agent" && cloudMailContextBlocked);

  const latestCitations = useMemo(() => {
    if (!active) return [];
    for (let i = active.messages.length - 1; i >= 0; i--) {
      const msg = active.messages[i]!;
      if (msg.role === "assistant" && msg.citations.length > 0) return msg.citations;
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
  // Countdown tick: re-renders every second while a confirmation waits, and
  // expires it automatically once its deadline passes.
  const [confirmationTick, setConfirmationTick] = useState(0);
  useEffect(() => {
    if (!pendingConfirmation) return;
    const timer = window.setInterval(() => setConfirmationTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pendingConfirmation]);
  const confirmationDeadline = pendingConfirmation ? Date.parse(pendingConfirmation.expiresAt) : 0;
  useEffect(() => {
    if (!pendingConfirmation || !Number.isFinite(confirmationDeadline)) return;
    if (Date.now() < confirmationDeadline) return;
    setActive((current) => current ? {
      ...current,
      messages: current.messages.map((message) => expireConfirmation(message, pendingConfirmation.id, t("agent.confirmation.expired"))),
    } : current);
  }, [confirmationDeadline, pendingConfirmation, t]);
  const confirmationRemaining = pendingConfirmation
    ? Math.max(0, confirmationDeadline - Date.now())
    : 0;
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
      writeRevokedIds(current.id, revokedIds);
      return { ...current, messages: current.messages.map((message) => (revokedIds.has(message.id) ? { ...message, revoked: true } : message)) };
    });
  }, []);
  const restoreMessage = useCallback((messageId: string) => {
    const restoreTarget = activeMessagesRef.current?.find((message) => message.id === messageId);
    setActive((current) => {
      if (!current) return current;
      const revokedIds = readRevokedIds(current.id);
      if (!revokedIds.delete(messageId)) return current;
      writeRevokedIds(current.id, revokedIds);
      return { ...current, messages: current.messages.map((message) => (message.id === messageId && message.revoked ? { ...message, revoked: false } : message)) };
    });
    if (restoreTarget?.role === "user") {
      setComposer((instruction) => instruction || restoreTarget.content);
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, []);

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
          <button className="agent-new-conversation-button" type="button" onClick={() => { setMobileConversationsOpen(false); void createConversation(); }} disabled={streaming || demoMode} aria-label={t("agent.conversation.new")} data-tooltip={t("agent.conversation.new")}><MessageCirclePlus size={16} /></button>
        </div>
        <div className="agent-sidebar-search"><Search size={15} /><label className="visually-hidden" htmlFor="agent-conversation-search">{t("agent.conversation.search")}</label><input id="agent-conversation-search" value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder={t("agent.conversation.searchPlaceholder")} /></div>
        <div className="agent-conversation-list">
          {loading && <div className="agent-sidebar-state"><LoaderCircle className="spin" size={18} />{t("agent.loading")}</div>}
          {!loading && !filteredConversations.length && <div className="agent-sidebar-state"><MessageCircle size={18} />{t("agent.conversation.empty")}</div>}
          {filteredConversations.map((conversation) => (
            <div key={conversation.id} className={`agent-conversation-row ${active?.id === conversation.id ? "active" : ""}`}>
              <button type="button" onClick={() => { setMobileConversationsOpen(false); void selectConversation(conversation.id); }} disabled={streaming}><span><strong>{conversation.title}</strong><small>{conversation.preview || t("agent.conversation.emptyPreview")}</small></span><time>{shortDate(conversation.updatedAt, locale)}</time></button>
              <button className="agent-row-delete" type="button" aria-label={t("agent.conversation.delete")} disabled={streaming} onClick={() => setPendingDeleteId((current) => current === conversation.id ? null : conversation.id)}><Trash2 size={14} /></button>
              {pendingDeleteId === conversation.id && <div className="agent-row-confirm"><span>{t("agent.conversation.deletePrompt")}</span><button type="button" onClick={() => void deleteConversation(conversation.id)}>{t("agent.conversation.delete")}</button><button type="button" onClick={() => setPendingDeleteId(null)}>{t("common.cancel")}</button></div>}
            </div>
          ))}
        </div>
        <div className="agent-sidebar-footer"><Bot size={15} /><span>{t("agent.localBoundary")}</span></div>
      </aside>

      <section className="agent-main-panel">
        <header className="agent-workspace-header">
          <div className="agent-conversation-heading">
            <span className="agent-heading-mark" aria-hidden="true"><img decoding="sync" className="nami-brand-logo nami-brand-logo-light" src="/nami-logo-light.png" alt="" /><img decoding="sync" className="nami-brand-logo nami-brand-logo-dark" src="/nami-logo-dark.png" alt="" /></span>
            {renaming && active ? (
              <form onSubmit={(event) => { event.preventDefault(); void renameConversation(); }}><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label={t("agent.conversation.rename")} autoFocus onBlur={() => setRenaming(false)} /></form>
            ) : <><div className="agent-conversation-title"><span className="eyebrow">{t("agent.eyebrow")}</span><h1>{active?.title ?? t("agent.conversation.newTitle")}</h1></div>{active && <button className="icon-button" type="button" aria-label={t("agent.conversation.rename")} data-tooltip={t("agent.conversation.rename")} onClick={() => { setDraftTitle(active.title); setRenaming(true); }}><Pencil size={15} /></button>}</>}
          </div>
          <div className="agent-header-actions">
            <div className="agent-scope-switch" role="group" aria-label={t("agent.scope.label")} data-scope={scopeMode}>
              <span className="agent-scope-thumb" aria-hidden="true" />
              {scopeOptions.map((option) => <button key={option.mode} type="button" className={scopeMode === option.mode ? "active" : ""} aria-pressed={scopeMode === option.mode} disabled={option.disabled} data-tooltip={option.title} onClick={() => setScopeMode(option.mode)}>{option.label}</button>)}
            </div>
            <button className="agent-mobile-conversations-button" type="button" aria-label={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} aria-expanded={mobileConversationsOpen} data-tooltip={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} onClick={() => setMobileConversationsOpen((open) => !open)}><PanelLeftClose size={17} /></button>
            {!hasConfiguredProvider ? <button ref={providerSettingsTriggerRef} className="agent-configure-provider-action" type="button" onClick={() => setProviderSettingsOpen(true)}><Wrench size={15} />{t("agent.providers.configure")}</button> : null}
            {hasConfiguredProvider && <button ref={providerSettingsTriggerRef} className="icon-button" type="button" onClick={() => setProviderSettingsOpen(true)} aria-label={t("agent.provider.settings")} data-tooltip={t("agent.provider.settings")}><Wrench size={17} /></button>}
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
          {!loading && !active && <div className="agent-empty-state"><span className="agent-wordmark" aria-hidden="true">{"NamiMailAgent".split("").map((char, index) => <span key={index} style={{ animationDelay: `${index * 0.05}s` }}>{char}</span>)}</span>{hasConfiguredProvider ? <div className="agent-suggestion-cards"><button className="agent-suggestion-card" type="button" onClick={() => setComposer(t("agent.suggestion.today"))}><CalendarDays size={17} /><span>{t("agent.suggestion.today")}</span></button><button className="agent-suggestion-card" type="button" onClick={() => setComposer(t("agent.suggestion.actionItems"))}><ClipboardList size={17} /><span>{t("agent.suggestion.actionItems")}</span></button><button className="agent-suggestion-card" type="button" onClick={() => setComposer(t("agent.suggestion.reply"))}><Reply size={17} /><span>{t("agent.suggestion.reply")}</span></button></div> : <button className="agent-configure-provider-button" type="button" onClick={() => setProviderSettingsOpen(true)}><Wrench size={16} />{t("agent.providers.configure")}</button>}</div>}
          {active?.messages.map((message, index) => (
            <AgentMessageRow
              key={message.id}
              message={message}
              superseded={index < lastUserMessageIndex}
              statusMessage={streamStatus}
              locale={locale}
              t={t}
              onOpenAttachment={openAttachmentFolder}
              onCopy={copyText}
              onRevoke={revokeMessage}
              onRestore={restoreMessage}
              onRetry={retryLastUserTurn}
              onUserMessageRef={registerUserMessageEl}
            />
          ))}
          <div ref={messagesEndRef} />
          {contextMenu && (
            <div className="agent-context-menu" ref={contextMenuRef} style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => { void copyText(contextMenu.text); setContextMenu(null); }}><Copy size={14} /><span>{t("agent.message.copy")}</span></button>
              <button type="button" role="menuitem" onClick={() => { setQuoteContext(contextMenu.text); setContextMenu(null); window.requestAnimationFrame(() => composerRef.current?.focus()); }}><ArrowUp size={14} /><span>{t("agent.message.followUp")}</span></button>
            </div>
          )}
        </div>
        {userMessages.length > 0 && (
          <div
            className="agent-scrubber"
            role="presentation"
            ref={scrubberTrackRef}
            onMouseLeave={() => { setHoveredUserIndex(null); setScrubberScrolling(false); }}
            onMouseMove={handleScrubberMove}
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
            {hoveredUserMessage && scrubberViewport !== null && (
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
          {pendingConfirmation && <AgentConfirmationCard
            confirmation={pendingConfirmation}
            desktopConfirmationAvailable={desktopConfirmationAvailable}
            resolutionError={confirmationErrors[pendingConfirmation.id]}
            onDecision={demoMode ? (decision) => resolveDemoConfirmation(pendingConfirmation.id, decision) : undefined}
            remainingMs={confirmationRemaining}
          />}
          <div className="agent-composer">
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
                          .then(() => setPendingMemorySuggestions((suggestions) => suggestions.filter((item) => item !== summary)))
                          .catch((error) => {
                            // Keep the chip so the user can retry; the error
                            // banner explains what went wrong.
                            setLoadError(error instanceof Error ? error.message : t("agent.error.saveMemory"));
                          });
                      }}
                    >{t("agent.memory.suggestion.save")}</button>
                    <button className="agent-memory-suggestion-dismiss" type="button" onClick={() => setPendingMemorySuggestions((suggestions) => suggestions.filter((item) => item !== summary))}>{t("agent.memory.suggestion.dismiss")}</button>
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
                    <button type="button" className={`agent-composer-permission${agentAccessLevel === "full-access" ? " full-access" : ""}`} onClick={() => setPermissionOpen((open) => !open)} aria-expanded={permissionOpen} aria-haspopup="menu" aria-label={t("agent.permission.label")}>
                      {agentAccessLevel === "full-access" ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
                      <span>{currentPermissionLabel}</span>
                      <ChevronDown size={11} className={`agent-permission-chevron${permissionOpen ? " open" : ""}`} aria-hidden="true" />
                    </button>
                    {permissionPopover.mounted && (
                      <div className={`agent-popover anchor-left${permissionPopover.visible ? " show" : ""}`} role="menu" aria-label={t("agent.permission.label")}>
                        {permissionOptions.map((option) => {
                          const active = agentAccessLevel === option.level;
                          return (
                            <button key={option.level} type="button" role="menuitemradio" aria-checked={active} className={`agent-popover-option${active ? " active" : ""}${option.level === "full-access" ? " danger" : ""}`} onClick={() => {
                              if (option.level === "full-access" && !active) {
                                setPermissionOpen(false);
                                setPendingAccessLevel("full-access");
                                return;
                              }
                              setPermissionOpen(false);
                              if (!active) onAgentAccessLevelChange?.(option.level);
                            }}>
                              <span className="agent-popover-option-radio" aria-hidden="true" />
                              <span className="agent-popover-option-copy">
                                <strong>{option.label}</strong>
                                <small>{option.detail}</small>
                              </span>
                              {active && <Check size={13} className="agent-popover-option-check" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="agent-composer-bar-right">
                {streaming && <LoaderCircle size={13} className="spin agent-composer-loading" aria-label={t("agent.composer.stop")} />}
                {hasConfiguredProvider && (
                  <div className="agent-composer-model-wrap" ref={modelPickerRef}>
                    <button type="button" className="agent-composer-model" onClick={() => setModelPickerOpen((open) => !open)} aria-expanded={modelPickerOpen} aria-haspopup="menu" aria-label={t("agent.provider.label")} disabled={streaming}>
                      <Bot size={12} aria-hidden="true" />
                      <span>{selectedProvider ? `${selectedProvider.label} · ${selectedProvider.model}` : ""}</span>
                      <ChevronDown size={11} className={`agent-model-chevron${modelPickerOpen ? " open" : ""}`} aria-hidden="true" />
                    </button>
                    {modelPopover.mounted && (
                      <div className={`agent-popover anchor-right${modelPopover.visible ? " show" : ""}`} role="menu" aria-label={t("agent.provider.label")}>
                        {configuredProviders.map((provider) => {
                          const isCurrent = selectedProvider?.id === provider.id;
                          return (
                            <button key={provider.id} type="button" role="menuitemradio" aria-checked={isCurrent} className={`agent-popover-option${isCurrent ? " active" : ""}`} onClick={() => {
                              setProviderId(provider.id);
                              // Pin the chosen model to the active conversation so switching
                              // back restores it; conversations without an explicit choice
                              // keep using the default provider.
                              if (!isCurrent && active) setConversationProviders((prev) => ({ ...prev, [active.id]: provider.id }));
                              setModelPickerOpen(false);
                            }}>
                              <span className="agent-popover-option-radio" aria-hidden="true" />
                              <span className="agent-popover-option-copy">
                                <strong>{provider.label} · {provider.model}</strong>
                                <small>{provider.cloud ? t("agent.provider.cloud") : t("agent.provider.local")}</small>
                              </span>
                              {isCurrent && <Check size={13} className="agent-popover-option-check" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {streaming ? <button className="agent-send-button stop" type="button" onClick={stopStreaming} aria-label={t("agent.composer.stop")} data-tooltip={t("agent.composer.stop")}><Square size={12} fill="currentColor" /></button> : <button className="agent-send-button" type="button" disabled={sendDisabled} onClick={() => void sendMessage()} aria-label={t("agent.composer.send")} data-tooltip={t("agent.composer.send")}><ArrowUp size={16} strokeWidth={2.5} /></button>}
              </div>
            </div>
          </div>
          {!hasConfiguredProvider && <div className="agent-provider-required" role="status"><Wrench size={15} /><span>{t("agent.providers.noConfiguredDescription")}</span><button type="button" onClick={() => setProviderSettingsOpen(true)}>{t("agent.providers.configure")}</button></div>}
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
        open={providerSettingsOpen}
        initialProviders={providers}
        initialDefaultProviderId={bootstrap?.defaultProviderId ?? null}
        onClose={() => setProviderSettingsOpen(false)}
        onOpenMcpServers={() => {
          setProviderSettingsOpen(false);
          setMcpServerSettingsOpen(true);
        }}
        onProvidersChanged={applyProviderList}
        restoreFocusRef={providerSettingsTriggerRef}
      />
      <AgentMcpServerSettings
        open={mcpServerSettingsOpen}
        onClose={() => setMcpServerSettingsOpen(false)}
        onOpenProviders={() => {
          setMcpServerSettingsOpen(false);
          setProviderSettingsOpen(true);
        }}
        restoreFocusRef={providerSettingsTriggerRef}
      />
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
