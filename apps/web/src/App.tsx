import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import DOMPurify from "dompurify";
import {
  Archive,
  ArrowLeft,
  AtSign,
  Calendar,
  CalendarArrowDown,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  Download,
  Eye,
  FilePenLine,
  Forward,
  Inbox,
  Layers3,
  LayoutTemplate,
  ListChecks,
  ListFilter,
  LoaderCircle,
  Mail,
  MailOpen,
  Menu,
  MoreHorizontal,
  Moon,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  Sparkles,
  Star,
  Sun,
  Users,
  Trash2,
  X,
  Printer,
  UserRound,
} from "lucide-react";
import { AgentMark } from "./AgentMark";
import { CustomAvatar } from "./SenderAvatar";
import { WindowBar } from "./WindowBar";
import { ApiError, api, type BatchJobCreatePayload, type BatchJobQuery, type BatchJobSnapshot, type MoveTarget } from "./api";
import { calendarCache, contactsCache, templatesCache } from "./dialogPrefetch";
import DatePicker from "./DatePicker";
import { canPreviewAttachment } from "./attachmentPreview";
import { attachmentKinds, presentAttachment, type AttachmentKind } from "./attachmentPresentation";
import { AttachmentFileIcon, FolderNavigationIcon, formatFileSize, isoFromDatetimeLocal, IconButton, type ComposeDraft, type ToastKind } from "./mailUi";
import { parseMailtoUrl } from "./mailtoLink";
import { attachmentsZipFilename, buildAttachmentsZipBlob, triggerBlobDownload } from "./attachmentZip";
import { calendarEventIcs, exportDownloadFilename, vCardText } from "./contactExport";
import { desktopBridge, type DesktopAutoReplyNotice, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import { resolveUpdateFooter, type UpdateFooterAction } from "./updateFooter";
import { demoDataSnapshot, ensureDemoLoaded } from "./demo-loader";
import { mailErrorMessage, mailErrorToastMessage, presentMailError, type MailErrorPresentation } from "./errorPresentation";
import { AccountHealthBanner, accountShowsFreshness, accountStatusDotClass, useAccountHealth } from "./accountHealth";
import { useRealtimeSync } from "./realtimeSync";
import { buildForwardDraft, buildReplyDraft, buildReplyQuote } from "./mailActions";
import { ComposeModal } from "./ComposeModal";
import { sortMessages } from "./mailImportance";
import { groupMessagesByThread, shouldCollapseThread, sortThreadByTimeline } from "./threads";
import { ErrorBoundary } from "./ErrorBoundary";
import { mailBackgroundColor, mailReaderSurface, mailSurfaceForBackground, shouldResetMailForeground, type MailSurface } from "./mailHtmlTheme";
import {
  applyBatchSeenChange as applyBatchSeenChangeState,
  applyMessageMove,
  applyMessageMoveConfirmation,
  applyMessageSeenChange,
  isArchivedMessage,
  isInboxMessage,
  isSnoozedMessage,
  matchesServerMessageQuery,
  mergeLocalPendingSeen,
  mergePendingArchiveMoves,
  mergeRolledBackMessages,
  mergeUnreadViewSnapshot,
  nextMessageTotalForMove,
  nextUnreadViewRecentlyReadIds,
  revertMessageMove,
  sidebarBadgeCounts,
  type MessageListQuery,
  type MessageListSortOrder,
  type PendingArchiveMove,
} from "./mailListState";
import { sortSubmissions, submissionStatusNeedsRefresh } from "./sendingStatus";
import { providerDisplayName } from "./providerOnboarding";
import { canPlayCustomNotificationSound, playNotificationSound, primeNotificationSound } from "./sounds";
import { saveLocalePreference } from "./localePreference";
import { createSettingsLoadCoordinator } from "./settingsLoadCoordinator";
import TranslationPanel, { type TranslationAvailability, type TranslationContent, type TranslationPanelState } from "./TranslationPanel";
import { applyMailTranslation, extractMailTextSegments } from "./mailDomTranslation";
import { extractMailVisualStyle, llmTranslationErrorMessage, translationErrorMessage } from "./translationPresentation";
import { defaultAppSettings, type Account, type AppSettings, type AppSettingsPatch, type Message, type MessageAttachment, type OutboundAttachment, type OutboundSubmission, type ProviderInfo, type Stats } from "./types";
import { useDialogFocus } from "./useDialogFocus";
import { dialogKeydownDecision, useDialogRouting } from "./dialogRouting";
import { findVerificationCodes } from "./verificationCode";
import { resolveLocale, type Translate, useI18n } from "./i18n";
import type { AgentBootstrap } from "./agentTypes";
import MessageList from "./MessageList";
import { AutoReplyToastStack, autoReplyNoticeKey } from "./AutoReplyToastStack";

const AgentWorkspace = lazy(() => import("./AgentWorkspace"));
const AccountConnectionModal = lazy(() => import("./AddAccountModal"));
const AttachmentPreviewModal = lazy(() => import("./AttachmentPreviewModal"));
const SettingsModal = lazy(() => import("./SettingsModal"));
const AccountsDialog = lazy(() => import("./AccountsDialog"));
const CalendarDialog = lazy(() => import("./CalendarDialog"));
const ManagementDialogs = lazy(async () => {
  const module = await import("./ManagementDialogs");
  return { default: module.ContactsDialog };
});
const TemplatesDialog = lazy(async () => {
  const module = await import("./ManagementDialogs");
  return { default: module.TemplatesDialog };
});
const SendingStatusModal = lazy(() => import("./SendingStatusModal"));
const StartupUpdatePrompt = lazy(() => import("./StartupUpdatePrompt"));
const TranslationTermsDialog = lazy(() => import("./TranslationTermsDialog"));

type MailView = MessageListQuery["messageView"];
type ToastAction = { label: string; run: () => void };
type ToastNotice = { kind: ToastKind; message: string; action?: ToastAction } | null;

// Interface-switch ("fade hand-off") phases between the mail workspace and the
// Agent workspace. Each interface fades out/in in two layers — the mail
// sidebar and workspace leave first, then the Agent's conversation rail and
// main panel enter (and vice versa on close). These phases only drive class
// names; the motion itself lives in styles.css. `idle` is the settled state in
// either direction.
type AgentPhase = "idle" | "mail-leaving" | "agent-entering" | "agent-leaving" | "mail-entering";
// Per-layer fade duration and the stagger between layers. Totals must match
// the CSS animations (mail = 2 leaving layers, agent = 2 entering layers) —
// see `.mail-shell[data-agent-phase]`.
const SWITCH_FADE_MS = 240;
const MAIL_FADE_STAGGER_MS = 60;
const AGENT_FADE_STAGGER_MS = 80;
const MAIL_SWITCH_TOTAL_MS = SWITCH_FADE_MS + MAIL_FADE_STAGGER_MS;
const AGENT_SWITCH_TOTAL_MS = SWITCH_FADE_MS + AGENT_FADE_STAGGER_MS;
type TranslationSession = {
  messageId: string;
  targetLocale: string;
  state: TranslationPanelState;
};
type AttachmentDownloadState = {
  phase: "downloading" | "ready" | "error";
  detail?: string;
};

function retainedTranslationContent(state: TranslationPanelState): TranslationContent | undefined {
  if (state.phase === "ready") {
    return {
      translatedText: state.translatedText,
      ...(state.detectedLanguage ? { detectedLanguage: state.detectedLanguage } : {}),
      visible: state.visible,
    };
  }
  return state.phase === "loading" || state.phase === "error" ? state.previous : undefined;
}

const isDemo = new URLSearchParams(window.location.search).get("demo") === "1";
const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
const isDesktopSmoke = new URLSearchParams(window.location.search).get("desktopSmoke") === "1";
// The desktop shell injects its host platform ("win32" | "darwin" | "linux")
// so the window bar can pick the frameless layout (own controls vs. the
// macOS traffic-light slot).
const desktopPlatform = new URLSearchParams(window.location.search).get("platform") ?? undefined;

// Mirrors MAX_TRANSLATION_TEXT_LENGTH in the local server so the reader rejects
// oversized messages before any mail content is sent to a translation provider.
const MAX_LLM_TRANSLATION_TEXT_LENGTH = 50_000;

function formatMessageTime(value: string, locale: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

function formatFullDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSyncFreshness(value: string | null, t: Translate): string {
  if (!value) return t("mail.sync.never");
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 60) return t("mail.sync.justNow");
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return t(elapsedMinutes === 1 ? "mail.sync.minuteAgo" : "mail.sync.minutesAgo", { count: elapsedMinutes });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return t(elapsedHours === 1 ? "mail.sync.hourAgo" : "mail.sync.hoursAgo", { count: elapsedHours });
  const elapsedDays = Math.floor(elapsedHours / 24);
  return t(elapsedDays === 1 ? "mail.sync.dayAgo" : "mail.sync.daysAgo", { count: elapsedDays });
}

function isCompactMailLayout(): boolean {
  return window.matchMedia("(max-width: 620px)").matches;
}

function buildMessageQuery({
  accountId,
  folder,
  search,
  messageView,
  searchScope,
  attachmentKind,
  after,
  before,
  page = 1,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
  searchScope: "view" | "all";
  attachmentKind?: AttachmentKind;
  after?: string;
  before?: string;
  page?: number;
}): string {
  const query = new URLSearchParams({ pageSize: "100" });
  if (page > 1) query.set("page", String(page));
  const globalSearch = searchScope === "all" && search.trim() !== "";
  if (!globalSearch) {
    if (accountId !== "all") query.set("accountId", accountId);
    if (folder) query.set("folder", folder);
    if (messageView === "starred") query.set("starred", "1");
    if (messageView === "unread") query.set("unread", "1");
    if (messageView === "archived") query.set("archived", "1");
    if (messageView === "snoozed") query.set("snoozed", "1");
    if (messageView === "attachments") query.set("hasAttachments", "1");
  }
  // Kind and date refinements survive the global-search switch too; the
  // server applies them on top of the FTS candidate set.
  if (attachmentKind) query.set("attachmentKind", attachmentKind);
  if (after) query.set("after", after);
  if (before) query.set("before", before);
  if (search.trim()) {
    query.set("q", search.trim());
    if (globalSearch) query.set("scope", "all");
  }
  return query.toString();
}

function demoMessageTotal(messages: readonly Message[], accounts: readonly Account[], {
  accountId,
  folder,
  search,
  messageView,
  searchScope,
  attachmentKind,
  after,
  before,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
  searchScope: "view" | "all";
  attachmentKind?: AttachmentKind;
  after?: string;
  before?: string;
}): number {
  const normalizedQuery = search.trim().toLowerCase();
  return messages.filter((message) => {
    if (!(searchScope === "all" && normalizedQuery)) {
      if (accountId !== "all" && message.accountId !== accountId) return false;
      if (folder && message.mailbox !== folder) return false;
      if (!folder && messageView === "inbox" && !isInboxMessage(message, accounts)) return false;
      if (messageView === "unread" && message.seen) return false;
      if (messageView === "starred" && !message.flagged) return false;
      if (messageView === "archived" && !isArchivedMessage(message, accounts)) return false;
      if (messageView === "snoozed" && !isSnoozedMessage(message)) return false;
      if (messageView === "attachments" && !message.hasAttachments) return false;
    }
    if (attachmentKind
      && !message.attachments.some((item) => presentAttachment(item.filename, item.contentType).kind === attachmentKind)) {
      return false;
    }
    if (after || before) {
      const sentTime = new Date(message.sentAt).getTime();
      if (!Number.isFinite(sentTime)) return false;
      if (after && sentTime < new Date(after).getTime()) return false;
      if (before && sentTime >= new Date(before).getTime()) return false;
    }
    if (normalizedQuery && !`${message.subject} ${message.from.name} ${message.from.address} ${message.snippet}`.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  }).length;
}

const moveTargetSpecialUses: Record<MoveTarget, string[]> = {
  archive: ["\\Archive", "\\All"],
  trash: ["\\Trash"],
  junk: ["\\Junk"],
  inbox: ["\\Inbox"],
};

// The confirmation toasts differ per action; spam actions reuse the same
// success wording whether they came from the reader menu or the batch bar.
function moveActionKey(target: MoveTarget, selection: boolean): string {
  if (selection) {
    return target === "archive" ? "mail.selection.archived" : target === "trash" ? "mail.selection.trashed" : "mail.selection.reportedSpam";
  }
  return target === "archive" ? "mail.action.archived" : target === "trash" ? "mail.action.trashed" : target === "junk" ? "mail.action.reportedSpam" : "mail.action.recoveredFromSpam";
}

function demoMoveDestination(accounts: readonly Account[], accountId: string, target: MoveTarget): string {
  const folders = accounts.find((account) => account.id === accountId)?.folders ?? [];
  for (const specialUse of moveTargetSpecialUses[target]) {
    const folder = folders.find((item) => item.specialUse === specialUse);
    if (folder) return folder.path;
  }
  return "";
}

function initials(name: string, address: string): string {
  const value = name.trim() || address.split("@")[0] || "?";
  return [...value].slice(0, 2).join("").toUpperCase();
}

function accountTone(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
}

function currentSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(preference: AppSettings["theme"], systemTheme: "light" | "dark"): "light" | "dark" {
  return preference === "system" ? systemTheme : preference;
}

function backgroundUrl(settings: AppSettings): string | null {
  if (settings.backgroundPreset === "custom") return settings.customBackgroundUrl;
  if (settings.backgroundPreset === "none") return null;
  return `/backgrounds/${settings.backgroundPreset}.svg`;
}

function reportCustomNotificationSoundAvailability(): void {
  desktopBridge()?.setCustomNotificationSoundReady(canPlayCustomNotificationSound());
}

function sanitizeMailHtml(html: string, darkMode: boolean): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "img", "form"],
  });

  const template = document.createElement("template");
  template.innerHTML = clean;
  const elements = [...template.content.querySelectorAll("*")];
  for (const element of elements) {
    const styled = element as HTMLElement;
    // Mail content is intentionally selectable. Remove only the inline
    // properties that can override the reader's explicit selection policy.
    styled.style?.removeProperty("user-select");
    styled.style?.removeProperty("-webkit-user-select");
    // Email content must not be able to opt itself into the reader's surface
    // normalization before we classify its own declared background.
    element.removeAttribute("data-nami-mail-surface");
  }
  const surfaceByElement = new Map<Element, MailSurface>();
  for (const element of elements) {
    const styled = element as HTMLElement;
    const surface = mailSurfaceForBackground(mailBackgroundColor(
      styled.style?.getPropertyValue("background-color") || styled.style?.backgroundColor,
      styled.style?.getPropertyValue("background") || styled.style?.background,
      element.getAttribute("bgcolor") || element.getAttribute("background"),
    ));
    if (!surface) continue;
    surfaceByElement.set(element, surface);
    element.setAttribute("data-nami-mail-surface", surface.tone);
  }

  const readerSurface = mailReaderSurface(darkMode ? "dark" : "light");
  const nearestSurface = (element: Element): MailSurface => {
    let current: Element | null = element;
    while (current) {
      const surface = surfaceByElement.get(current);
      if (surface) return surface;
      current = current.parentElement;
    }
    return readerSurface;
  };

  for (const element of elements) {
    const styled = element as HTMLElement;
    const surface = nearestSurface(element);
    // WebKit text fill wins over `color` when present. Email generators use it
    // surprisingly often, so checking only `color` can still leave white copy
    // on a light table after sanitization.
    const foregrounds = [
      { value: styled.style?.getPropertyValue("-webkit-text-fill-color") ?? "", reset: () => styled.style?.removeProperty("-webkit-text-fill-color") },
      { value: styled.style?.getPropertyValue("color") ?? "", reset: () => styled.style?.removeProperty("color") },
      { value: element.getAttribute("color") ?? "", reset: () => element.removeAttribute("color") },
    ].filter((foreground) => Boolean(foreground.value));
    // Links retain recognizable brand colors, but still need a visible
    // contrast floor distinct from the stricter body-copy requirement.
    const minimumContrast = element.closest("a") ? 3 : undefined;
    const readableForeground = foregrounds.some((foreground) => !shouldResetMailForeground(foreground.value, surface, minimumContrast));
    for (const foreground of foregrounds) {
      if (shouldResetMailForeground(foreground.value, surface, minimumContrast)) foreground.reset();
    }
    // The app's light reader would otherwise provide dark inherited text for
    // a dark authored table. Give only unstyled or corrected surface roots a
    // readable inherited foreground, while preserving intentional email colors.
    if (!darkMode && surfaceByElement.get(element)?.tone === "dark" && !readableForeground) {
      styled.style?.setProperty("color", "#f5f5f6");
      styled.style?.setProperty("-webkit-text-fill-color", "#f5f5f6");
      styled.style?.setProperty("color-scheme", "dark");
    }
  }
  return template.innerHTML;
}

function textFromSanitizedMailHtml(html: string): string {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

/**
 * Composes the reply body: the sender's signature, a blank line, then the
 * quoted original message. The empty leading block keeps the reply cursor at
 * the top while the signature and quote sit beneath it.
 */
function replyBody(message: Message, accounts: readonly Account[], locale: string, t: Translate, safeHtml: string): string {
  const signature = accounts.find((account) => account.id === message.accountId)?.signature ?? "";
  const body = message.textBody || textFromSanitizedMailHtml(safeHtml) || message.snippet;
  const sender = message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address;
  const quote = buildReplyQuote(body, t("compose.replyQuote", {
    date: formatFullDate(message.sentAt, locale),
    sender,
  }));
  return signature.trim() ? `${signature.trim()}\n\n${quote}` : `\n\n${quote}`;
}

async function copyVerificationCodeToClipboard(code: string): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge?.copyVerificationCode) {
    try {
      if ((await bridge.copyVerificationCode(code)).copied) return true;
    } catch {
      // Browser APIs below keep the web build usable when desktop clipboard
      // access is unavailable for a particular session.
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      return true;
    }
  } catch {
    // Some browsers allow clipboard writes only over secure contexts. Use the
    // short-lived selection fallback instead of retaining message content.
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = code;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

export default function App() {
  const { locale, setLocale, t } = useI18n();
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(currentSystemTheme);
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...defaultAppSettings, locale }));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingArchiveMoves, setPendingArchiveMoves] = useState<PendingArchiveMove[]>([]);
  const [pendingMoveVerifications, setPendingMoveVerifications] = useState<string[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  const [stats, setStats] = useState<Stats>({ accounts: 0, messages: 0, unread: 0 });
  const [unreadViewRecentlyReadIds, setUnreadViewRecentlyReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [translationSession, setTranslationSession] = useState<TranslationSession | null>(null);
  const [translationAvailability, setTranslationAvailability] = useState<TranslationAvailability>(isDemo ? "available" : "checking");
  // The shell's modal/panel routing (nine dialogs, attachment preview, mobile
  // sidebar, translation-terms gate) and the global keydown decisions live in
  // useDialogRouting; the update prompt, reader-domain, and agent-workspace
  // routing stay here.
  const { state, actions, translationTermsPendingRef } = useDialogRouting();
  const [view, setView] = useState<MailView>("inbox");
  const [selectedAccount, setSelectedAccount] = useState("all");
  // The bottom fade strip one-tap expands every account row (and hides the
  // folder list) so accounts that were folded or overflow the viewport can
  // still be reached; collapsing restores the previous mode.
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const accountListRef = useRef<HTMLDivElement>(null);
  const [accountListOverflow, setAccountListOverflow] = useState(false);
  const [accountListAtBottom, setAccountListAtBottom] = useState(true);
  useEffect(() => {
    const el = accountListRef.current;
    if (!el) return;
    const update = () => {
      setAccountListOverflow(el.scrollHeight > el.clientHeight + 1);
      setAccountListAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [accounts.length, selectedAccount, accountsExpanded]);
  // The folder tree animates its max-height into whatever vertical room the
  // sidebar has left, so a short folder list never shows a scrollbar while
  // there is free space below (only the fixed 36vh cap caused that). The
  // measured value feeds the --folder-list-max variable used in styles.css.
  const folderListRef = useRef<HTMLDivElement>(null);
  const [folderListMaxHeight, setFolderListMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const folderList = folderListRef.current;
    const footer = sidebar?.querySelector<HTMLElement>(".sidebar-footer");
    if (!sidebar || !folderList || !footer) return;
    const measure = () => {
      const sidebarRect = sidebar.getBoundingClientRect();
      const folderTop = folderList.getBoundingClientRect().top - sidebarRect.top;
      const paddingBottom = Number.parseFloat(getComputedStyle(sidebar).paddingBottom) || 0;
      const available = Math.floor(sidebar.clientHeight - folderTop - footer.offsetHeight - paddingBottom);
      setFolderListMaxHeight(Math.max(60, available));
    };
    measure();
    // Layout of any sibling (nav-section collapse, account rows folding,
    // more button appearing) moves the folder list top, so watch them all.
    const observer = new ResizeObserver(measure);
    for (const child of sidebar.children) observer.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [accountsExpanded, selectedAccount, accounts.length]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  /** Search reach: within the current view, or every account and mailbox. */
  const [searchScope, setSearchScope] = useState<"view" | "all">("view");
  const [sortOrder, setSortOrder] = useState<MessageListSortOrder>("newest");
  const [filterAttachments, setFilterAttachments] = useState(false);
  /** Whether the compact sort/filter panel (list toolbar) is open. */
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  /** Whether the header search box is expanded (icon-only when collapsed). */
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("idle");
  const [agentProviderSettingsRequestId, setAgentProviderSettingsRequestId] = useState(0);
  const [submissions, setSubmissions] = useState<OutboundSubmission[]>([]);
  const [submissionLoading, setSubmissionLoading] = useState(true);
  const [submissionLoadError, setSubmissionLoadError] = useState<string | null>(null);
  const [messageAction, setMessageAction] = useState<MoveTarget | null>(null);
  const [messageFlagging, setMessageFlagging] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectAllPaged, setSelectAllPaged] = useState(false);
  const [batchJob, setBatchJob] = useState<BatchJobSnapshot | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [attachmentKindFilter, setAttachmentKindFilter] = useState<AttachmentKind | undefined>(undefined);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Local calendar dates become exclusive UTC instants for the server query:
  // "after" starts at the from-date's local midnight and "before" runs one
  // day past the to-date. Calendar arithmetic via setDate keeps both bounds
  // DST-proof and rolls over month/year boundaries.
  const dateBounds = useMemo(() => {
    const after = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined;
    let before: string | undefined;
    if (dateTo) {
      const endExclusive = new Date(`${dateTo}T00:00:00`);
      endExclusive.setDate(endExclusive.getDate() + 1);
      before = endExclusive.toISOString();
    }
    return { after, before };
  }, [dateFrom, dateTo]);
  const [attachmentDownloads, setAttachmentDownloads] = useState<Record<string, AttachmentDownloadState>>({});
  const [zipAllPhase, setZipAllPhase] = useState<"idle" | "zipping">("idle");
  const [recipientDetailsOpen, setRecipientDetailsOpen] = useState(false);
  const [readerMoreOpen, setReaderMoreOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeCustomUntil, setSnoozeCustomUntil] = useState("");
  const [toast, setToast] = useState<ToastNotice>(null);
  const [autoReplyNotices, setAutoReplyNotices] = useState<DesktopAutoReplyNotice[]>([]);
  const [fatalError, setFatalError] = useState<MailErrorPresentation | null>(null);
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateSnapshot | null>(null);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [updateFooterBusy, setUpdateFooterBusy] = useState(false);
  const [preloadedAgentBootstrap, setPreloadedAgentBootstrap] = useState<AgentBootstrap | null>(null);
  const splashAnimationDoneRef = useRef(false);
  const splashDataDoneRef = useRef(false);
  const splashAgentDoneRef = useRef(false);
  const splashDismissedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const agentLaunchButtonRef = useRef<HTMLButtonElement>(null);
  const readerTitleRef = useRef<HTMLHeadingElement>(null);
  const readerMoreRef = useRef<HTMLDivElement>(null);
  const snoozeRef = useRef<HTMLDivElement>(null);
  /** Anchors the compact sort/filter panel and closes it on outside clicks. */
  const listToolbarRef = useRef<HTMLDivElement>(null);
  /** Anchors the collapsible header search box so an outside click closes it. */
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const messageButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const messagesRef = useRef<Message[]>([]);
  const pendingArchiveMovesRef = useRef<PendingArchiveMove[]>([]);
  const unreadViewRecentlyReadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const seenMutationIdsRef = useRef(new Set<string>());
  const viewRef = useRef<MailView>("inbox");
  const lastOpenedMessageIdRef = useRef<string | null>(null);
  const translationRequestIdRef = useRef(0);
  const translationAvailabilityRequestIdRef = useRef(0);
  const translationAbortRef = useRef<AbortController | null>(null);
  const llmTranslationAbortRef = useRef<AbortController | null>(null);
  const settingsLoadCoordinatorRef = useRef(createSettingsLoadCoordinator());
  const demoLoadedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const submissionLoadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  // Scroll anchor for background refreshes: which row the user is reading, and
  // how far into that row the viewport top sits. Applied after the merged list
  // lands (or dropped when nothing is pinned).
  const scrollAnchorRef = useRef<{ id: string; offset: number; topCaptured: number } | null>(null);
  const batchJobStartedAtRef = useRef(0);
  const theme = resolveTheme(settings.theme, systemTheme);
  const activeBackgroundUrl = backgroundUrl(settings);
  // In light theme the pale canvas dilutes the picture; render the background
  // more densely there so presets stay visible. Dark theme is left untouched.
  const backgroundOpacity =
    activeBackgroundUrl && theme === "light"
      ? Math.min(1, (settings.backgroundIntensity * 1.22) / 100)
      : settings.backgroundIntensity / 100;
  const accountIdsKey = accounts.map((account) => account.id).sort().join("|");
  const pendingMoveVerificationKey = [...new Set([
    ...pendingMoveVerifications,
    ...pendingArchiveMoves.map((move) => move.id),
    ...messages.filter((message) => message.movePending === true).map((message) => message.id),
  ])].sort().join("|");
  const submissionStatusRefreshIdsKey = submissions
    .filter((submission) => submissionStatusNeedsRefresh(submission.deliveryStatus))
    .map((submission) => submission.id)
    .sort()
    .join("|");
  const submissionAttentionCount = submissions.filter((submission) => ["unknown_delivery", "failed"].includes(submission.deliveryStatus)).length;
  const submissionActiveCount = submissions.filter((submission) => ["pending", "submitting", "submitted"].includes(submission.deliveryStatus)).length;
  const submissionOutstandingCount = submissionAttentionCount + submissionActiveCount;
  const sidebarCounts = useMemo(() => sidebarBadgeCounts(stats), [stats]);
  useDialogFocus(state.mobileSidebar, sidebarRef);
  const showToast = useCallback((message: string, kind: ToastKind = "success", action?: ToastAction) => {
    setToast({ kind, message, action });
  }, []);

  // Block-assembly switch between the mail workspace and the Agent workspace.
  // Opening: mail blocks leave in order, then the Agent workspace mounts and
  // its blocks enter. Closing mirrors it. A shared ref makes the sequence
  // re-entrant (rapid open/close cancels the previous timers) so the phase
  // always lands on `idle` with the workspace in the requested state.
  const agentSwitchTimersRef = useRef<number[]>([]);
  // Mirrors `agentPhase` for the open/close controllers so they can read the
  // current phase synchronously without being recreated on every phase change.
  const agentPhaseRef = useRef<AgentPhase>("idle");
  const clearAgentSwitchTimers = () => {
    for (const timer of agentSwitchTimersRef.current) window.clearTimeout(timer);
    agentSwitchTimersRef.current = [];
  };
  const queueAgentTimer = (run: () => void, delay: number) => {
    agentSwitchTimersRef.current.push(window.setTimeout(run, delay));
  };

  const openAgentWorkspace = useCallback(() => {
    clearAgentSwitchTimers();
    if (agentPhaseRef.current === "mail-leaving" || agentPhaseRef.current === "agent-entering") return;
    agentPhaseRef.current = "mail-leaving";
    setAgentPhase("mail-leaving");
    // Warm the lazy chunk while the mail layers fade out so the workspace is
    // ready the moment it takes over (no Suspense spinner in the hand-off).
    void import("./AgentWorkspace").catch(() => undefined);
    queueAgentTimer(() => {
      setAgentOpen(true);
      agentPhaseRef.current = "agent-entering";
      setAgentPhase("agent-entering");
    }, MAIL_SWITCH_TOTAL_MS);
    queueAgentTimer(() => {
      agentPhaseRef.current = "idle";
      setAgentPhase("idle");
    }, MAIL_SWITCH_TOTAL_MS + AGENT_SWITCH_TOTAL_MS);
  }, []);

  const closeAgentWorkspace = useCallback(() => {
    clearAgentSwitchTimers();
    if (agentPhaseRef.current === "agent-leaving" || agentPhaseRef.current === "mail-entering") return;
    agentPhaseRef.current = "agent-leaving";
    setAgentPhase("agent-leaving");
    queueAgentTimer(() => {
      setAgentOpen(false);
      agentPhaseRef.current = "mail-entering";
      setAgentPhase("mail-entering");
    }, AGENT_SWITCH_TOTAL_MS);
    queueAgentTimer(() => {
      agentPhaseRef.current = "idle";
      setAgentPhase("idle");
    }, AGENT_SWITCH_TOTAL_MS + MAIL_SWITCH_TOTAL_MS);
  }, []);
  const applySettings = useCallback((nextSettings: AppSettings) => {
    const normalizedSettings = { ...nextSettings, locale: resolveLocale(nextSettings.locale) };
    settingsLoadCoordinatorRef.current.recordSettingsChange();
    setSettings(normalizedSettings);
    setLocale(normalizedSettings.locale);
    if (!isDemo) saveLocalePreference(normalizedSettings.locale);
    // Desktop-only behaviors live in the host process. Pushing on every
    // settings snapshot keeps optimistic and server-reconciled changes in
    // sync; in a browser the bridge is absent and these calls are no-ops.
    const bridge = desktopBridge();
    bridge?.setLaunchAtStartup?.(normalizedSettings.launchAtStartup);
    bridge?.setGlobalShortcutEnabled?.(normalizedSettings.globalShortcutEnabled);
  }, [setLocale]);
  const clearUnreadViewRecentlyRead = useCallback(() => {
    const next = new Set<string>();
    unreadViewRecentlyReadIdsRef.current = next;
    setUnreadViewRecentlyReadIds(next);
  }, []);
  const cancelScheduledSubmission = useCallback(async (submissionId: string) => {
    if (isDemo) {
      setSubmissions((current) => current.filter((item) => item.id !== submissionId));
      showToast(t("sending.cancelled.success"));
      return;
    }
    const result = await api.cancelScheduledSend(submissionId);
    if (!result.cancelled) throw new ApiError(t("sending.error.cancel"), "scheduled_send_not_cancellable");
    setSubmissions((current) => current.filter((item) => item.id !== submissionId));
    showToast(t("sending.cancelled.success"));
  }, [showToast, t]);
  const updateUnreadViewRecentlyRead = useCallback((message: Pick<Message, "id" | "seen">, nextSeen: boolean) => {
    const next = nextUnreadViewRecentlyReadIds(
      unreadViewRecentlyReadIdsRef.current,
      message,
      nextSeen,
      viewRef.current === "unread",
    );
    unreadViewRecentlyReadIdsRef.current = next;
    setUnreadViewRecentlyReadIds(next);
  }, []);

  const refreshSubmissions = useCallback(async (
    targetAccounts: Account[],
    { silent = false }: { silent?: boolean } = {},
  ): Promise<void> => {
    const requestId = ++submissionLoadRequestRef.current;
    if (!silent) setSubmissionLoading(true);
    if (isDemo || targetAccounts.length === 0) {
      setSubmissions(isDemo ? sortSubmissions((await ensureDemoLoaded()).createDemoSubmissions(locale)) : []);
      setSubmissionLoadError(null);
      setSubmissionLoading(false);
      return;
    }

    const settled = await Promise.allSettled(targetAccounts.map(async (account) => ({
      accountId: account.id,
      items: (await api.submissions(account.id, 100)).items,
    })));
    if (requestId !== submissionLoadRequestRef.current) return;

    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failedAccountIds = new Set(targetAccounts
      .filter((_, index) => settled[index]?.status === "rejected")
      .map((account) => account.id));
    const currentAccountIds = new Set(targetAccounts.map((account) => account.id));
    setSubmissions((current) => sortSubmissions([
      ...fulfilled.flatMap((result) => result.items),
      ...current.filter((item) => currentAccountIds.has(item.accountId) && failedAccountIds.has(item.accountId)),
    ]));

    const firstFailure = settled.find((result) => result.status === "rejected");
    setSubmissionLoadError(firstFailure?.status === "rejected"
      ? t("sending.loadError", {
        count: failedAccountIds.size,
        message: mailErrorToastMessage(firstFailure.reason, t("error.localServiceUnavailable.title"), t),
      })
      : null);
    setSubmissionLoading(false);
  }, [locale, t]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(currentSystemTheme());
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  // Hover-reveal scrollbars: Chromium matches container :hover only against
  // the scrollbar pseudo-elements' own states, never the track underneath —
  // and a mouse over the track still targets the container's DOM. So the
  // reveal class is driven geometrically: while the pointer sits inside the
  // container's track band (right/bottom edge, BAND px wide), the container
  // gets .scrollbar-reveal. Keep the selector list in sync with the
  // Hover-reveal list in styles.css, and BAND with the track width there.
  useEffect(() => {
    const REVEAL = [
      ".translation-terms-content", ".mail-html", ".mail-html pre", ".attachment-preview-text",
      ".thread-strip-messages", ".modal-backdrop", ".modal-card", ".update-prompt-card",
      ".accounts-editor-modal", ".contact-editor-modal", ".calendar-editor-modal", ".settings-modal",
      ".settings-body", ".compose-card > form", ".compose-contact-suggestions", ".compose-template-picker",
      ".sending-status-list", ".sending-status-floating-tooltip", ".external-guide-code",
      ".themed-select-menu", ".agent-message-content pre", ".agent-message-content table",
      ".agent-slash-menu", ".agent-provider-settings-scrim", ".agent-provider-list",
      ".agent-provider-form", ".agent-provider-settings-body", ".auto-reply-list",
      ".agent-memory-list", ".auto-reply-toast-reply",
      ".settings-account-signature textarea", ".template-editor textarea",
      ".agent-provider-field > textarea.agent-mcp-args-input", ".calendar-field textarea",
    ].join(",");
    const BAND = 8; // matches the custom track width in styles.css
    let raf = 0;
    const onMove = (event: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const x = event.clientX;
        const y = event.clientY;
        for (const el of document.querySelectorAll<HTMLElement>(REVEAL)) {
          const r = el.getBoundingClientRect();
          const onTrack =
            (x >= r.right - BAND && x <= r.right && y >= r.top && y <= r.bottom) ||
            (y >= r.bottom - BAND && y <= r.bottom && x >= r.left && x <= r.right);
          el.classList.toggle("scrollbar-reveal", onTrack);
        }
      });
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 820px)");
    const closeDesktopDrawer = () => {
      if (!mediaQuery.matches) actions.closeMobileSidebar();
    };
    mediaQuery.addEventListener("change", closeDesktopDrawer);
    closeDesktopDrawer();
    return () => mediaQuery.removeEventListener("change", closeDesktopDrawer);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // Suppress transition animations during the theme switch so the new
    // color scheme applies instantly instead of animating every element
    // at once (which causes a visible repaint storm / UI jank).
    root.classList.add("theme-transitioning");
    root.dataset.theme = theme;
    root.dataset.density = settings.listDensity;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#09090a" : "#f2f2f4");
    // Force a synchronous reflow so the browser applies the new theme
    // while transitions are still disabled.
    root.offsetHeight; // eslint-disable-line @typescript-eslint/no-unused-expressions
    // Re-enable transitions on the next frame.
    requestAnimationFrame(() => {
      root.classList.remove("theme-transitioning");
    });
  }, [theme, settings.listDensity]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const replacePendingArchiveMoves = useCallback((next: PendingArchiveMove[]) => {
    pendingArchiveMovesRef.current = next;
    setPendingArchiveMoves(next);
  }, []);

  const load = useCallback(async ({
    silent = false,
    accountId = selectedAccount,
    folder = selectedFolder,
    search = debouncedQuery,
    messageView = view,
    scope = searchScope,
  }: {
    silent?: boolean;
    accountId?: string;
    folder?: string;
    search?: string;
    messageView?: MailView;
    scope?: "view" | "all";
  } = {}) => {
    const requestId = ++loadRequestRef.current;
    // A full reload re-renders a fresh view; any predicate-wide selection was
    // scoped to the previous one.
    setSelectAllPaged(false);
    setBatchJob(null);
    try {
      if (!silent) setLoading(true);
      setFatalError(null);
      if (isDemo) {
        const demo = await ensureDemoLoaded();
        const demoTotal = demoMessageTotal(
          demoLoadedRef.current && messagesRef.current.length ? messagesRef.current : demo.demoMessages,
          demo.createDemoAccounts(locale),
          { accountId, folder, search, messageView, searchScope: scope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before },
        );
        if (!demoLoadedRef.current) {
          demoLoadedRef.current = true;
          setAccounts(demo.createDemoAccounts(locale));
          setProviders(demo.demoProviders);
          setMessages(demo.demoMessages);
          setMessagePage(1);
          setStats(demo.demoStats);
        }
        setMessageTotal(demoTotal);
        setMessagePage(1);
        setSubmissions(sortSubmissions(demo.createDemoSubmissions(locale)));
        setSubmissionLoadError(null);
        setSubmissionLoading(false);
      } else {
        const messageQuery = buildMessageQuery({ accountId, folder, search, messageView, searchScope: scope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before });
        const [nextAccounts, nextProviders, messagePage, nextStats] = await Promise.all([
          api.accounts(),
          api.providers(),
          api.messages(messageQuery),
          api.stats(),
        ]);
        if (requestId !== loadRequestRef.current) return;
        const pendingMerge = mergePendingArchiveMoves(
          messagePage.items,
          pendingArchiveMovesRef.current,
          nextAccounts,
          { accountId, folder, search, messageView, searchScope: scope },
        );
        const nextMessages = mergeLocalPendingSeen(
          mergeUnreadViewSnapshot(
            pendingMerge.items,
            messagesRef.current,
            unreadViewRecentlyReadIdsRef.current,
            messageView === "unread",
          ),
          messagesRef.current,
          seenMutationIdsRef.current,
        );
        setAccounts(nextAccounts);
        setProviders(nextProviders);
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
        setMessageTotal(Math.max(messagePage.total, pendingMerge.items.length));
        setMessagePage(messagePage.page);
        setStats(nextStats);
        setSelectedId((current) => {
          if (current && nextMessages.some((item) => item.id === current)) return current;
          return null;
        });
await refreshSubmissions(nextAccounts, { silent: true });
        if (!isDemo) {
          contactsCache.warm();
          templatesCache.warm();
          calendarCache.warm();
        }
      }
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        setFatalError(presentMailError(error, t));
        setSubmissionLoading(false);
        setSubmissionLoadError(mailErrorToastMessage(error, t("sending.error.load"), t));
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        if (!splashDataDoneRef.current) {
          splashDataDoneRef.current = true;
          if (splashAnimationDoneRef.current && splashAgentDoneRef.current && !splashDismissedRef.current) {
            splashDismissedRef.current = true;
            const el = document.getElementById("nami-splash");
            if (el) { el.classList.add("done"); setTimeout(() => el.remove(), 600); }
          }
        }
      }
    }
  }, [locale, selectedAccount, selectedFolder, debouncedQuery, refreshSubmissions, searchScope, t, view]);

  /**
   * Silent periodic refresh that preserves pagination progress: only the first
   * page, accounts/providers and stats are fetched, then merged into the already
   * loaded list in place (fresh heads prepended, known ids updated to server
   * truth, older loaded rows untouched). A full authoritative reload still runs
   * on view/account/query changes and after destructive operations.
   */
  // Remembers the row currently under the viewport top so a background merge
  // that prepends new mail (or re-sorts) can pin the reading position instead
  // of letting the list jump. Unset when the viewport is at the very top —
  // there new arrivals should simply show at the top of the list.
  const captureScrollAnchor = useCallback(() => {
    const viewport = messageListRef.current;
    if (!viewport) {
      scrollAnchorRef.current = null;
      return;
    }
    const top = viewport.scrollTop;
    if (top <= 0) {
      scrollAnchorRef.current = null;
      return;
    }
    let anchor: { id: string; offset: number; topCaptured: number } | null = null;
    for (const [id, node] of messageButtonRefs.current) {
      if (!node.isConnected) continue;
      const rect = node.getBoundingClientRect();
      const contentTop = rect.top - viewport.getBoundingClientRect().top + top;
      if (contentTop <= top && contentTop + rect.height > top) {
        anchor = { id, offset: top - contentTop, topCaptured: top };
        break;
      }
    }
    scrollAnchorRef.current = anchor;
  }, []);

  const silentRefresh = useCallback(async () => {
    if (isDemo) return;
    captureScrollAnchor();
    const requestId = ++loadRequestRef.current;
    try {
      const messageQuery = buildMessageQuery({ accountId: selectedAccount, folder: selectedFolder, search: debouncedQuery, messageView: view, searchScope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before });
      const [nextAccounts, nextProviders, firstPage, nextStats] = await Promise.all([
        api.accounts(),
        api.providers(),
        api.messages(messageQuery),
        api.stats(),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const pendingMerge = mergePendingArchiveMoves(
        firstPage.items,
        pendingArchiveMovesRef.current,
        nextAccounts,
        { accountId: selectedAccount, folder: selectedFolder, search: debouncedQuery, messageView: view, searchScope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before },
      );
      const current = messagesRef.current;
      const currentIds = new Set(current.map((item) => item.id));
      const freshById = new Map(pendingMerge.items.map((item) => [item.id, item]));
      const additions = pendingMerge.items.filter((item) => !currentIds.has(item.id));
      const merged = [
        ...additions,
        ...current.map((item) => freshById.get(item.id) ?? item),
      ];
      const nextMessages = mergeUnreadViewSnapshot(
        merged,
        current,
        unreadViewRecentlyReadIdsRef.current,
        view === "unread",
      );
      // Reads that are still being confirmed by the server must not be flipped
      // back by a poll snapshot that raced the optimistic local update.
      const withLocalSeen = mergeLocalPendingSeen(nextMessages, current, seenMutationIdsRef.current);
      const settled = view === "unread" || firstPage.total >= withLocalSeen.length
        ? withLocalSeen
        : withLocalSeen.slice(0, Math.max(0, firstPage.total));
      setAccounts(nextAccounts);
      setProviders(nextProviders);
      messagesRef.current = settled;
      setMessages(settled);
      setMessageTotal(Math.max(firstPage.total, pendingMerge.items.length, settled.length));
      setStats(nextStats);
      setSelectedId((value) => value && settled.some((item) => item.id === value) ? value : null);
      // A silent poll just succeeded, so the network is back: clear any
      // fatal-error banner that a previous full load may have raised.
      setFatalError(null);
      await refreshSubmissions(nextAccounts, { silent: true });
    } catch {
      // Silent refresh must never disturb the current list; the next tick retries.
    }
  }, [captureScrollAnchor, attachmentKindFilter, dateBounds, debouncedQuery, refreshSubmissions, searchScope, selectedAccount, selectedFolder, view]);

  const loadSettings = useCallback(async () => {
    if (isDemo) return;
    const ticket = settingsLoadCoordinatorRef.current.beginLoad();
    try {
      const nextSettings = await api.settings();
      if (!settingsLoadCoordinatorRef.current.canApplyLoad(ticket)) return;
      applySettings(nextSettings);
    } catch (error) {
      if (!settingsLoadCoordinatorRef.current.canApplyLoad(ticket)) return;
      showToast(t("settings.error.load", { message: mailErrorToastMessage(error, undefined, t) }), "error");
    }
  }, [applySettings, showToast, t]);

  const updateSettings = useCallback(async (patch: AppSettingsPatch) => {
    if (isDemo) {
      applySettings({ ...settings, ...patch, updatedAt: new Date().toISOString() });
      return;
    }
    applySettings(await api.updateSettings(patch));
  }, [applySettings, settings]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);

  // Splash screen coordination: dismiss when the animation timeline completes
  // (~2s) AND both the mail data load and agent bootstrap preload finish.
  const dismissSplash = useCallback(() => {
    if (splashDismissedRef.current) return;
    if (!splashAnimationDoneRef.current || !splashDataDoneRef.current || !splashAgentDoneRef.current) return;
    splashDismissedRef.current = true;
    const el = document.getElementById("nami-splash");
    if (el) {
      el.classList.add("done");
      setTimeout(() => el.remove(), 600);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      splashAnimationDoneRef.current = true;
      // If data or agent is still loading, show the loading bar
      if (!splashDataDoneRef.current || !splashAgentDoneRef.current) {
        const loader = document.querySelector(".nami-splash-loader");
        if (loader) loader.classList.add("visible");
      }
      dismissSplash();
    }, 2000);
    return () => clearTimeout(timer);
  }, [dismissSplash]);

  // Preload agent conversations during splash so the assistant panel is ready
  // instantly when the user opens it. Only keep recent summaries to bound memory.
  useEffect(() => {
    if (isDemo) {
      splashAgentDoneRef.current = true;
      dismissSplash();
      return;
    }
    void api.agentBootstrap().then((value) => {
      // Cap stored conversations to the 50 most recent to bound memory.
      const capped: AgentBootstrap = { ...value, conversations: value.conversations.slice(0, 50) };
      setPreloadedAgentBootstrap(capped);
    }).catch(() => undefined).finally(() => {
      splashAgentDoneRef.current = true;
      dismissSplash();
    });
  }, [dismissSplash]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return undefined;
    let active = true;
    let receivedUpdateEvent = false;
    const removeListener = bridge.onUpdateStatus((snapshot) => {
      receivedUpdateEvent = true;
      if (active) setDesktopUpdateStatus(snapshot);
    });
    void bridge.getUpdateStatus().then((snapshot) => {
      // Prefer a broadcast received after subscription over an older IPC
      // snapshot, so a just-found release cannot be hidden by a race.
      if (active && !receivedUpdateEvent && snapshot) setDesktopUpdateStatus(snapshot);
    }).catch(() => undefined);
    return () => {
      active = false;
      removeListener();
    };
  }, []);

  const runUpdateFooterAction = useCallback(async (action: UpdateFooterAction) => {
    const bridge = desktopBridge();
    if (!bridge || updateFooterBusy) return;
    setUpdateFooterBusy(true);
    try {
      if (action.kind === "download") {
        const snapshot = await bridge.downloadUpdate();
        if (snapshot) setDesktopUpdateStatus(snapshot);
      } else if (action.kind === "install") {
        const result = await bridge.installUpdate();
        setDesktopUpdateStatus((current) => result.snapshot ?? current);
        if (!result.accepted && !result.snapshot) showToast(t("update.prompt.error.notReady"), "error");
      } else {
        const snapshot = await bridge.checkForUpdates();
        if (snapshot) setDesktopUpdateStatus(snapshot);
      }
    } catch (error) {
      showToast(updateBridgeErrorMessage(error, t("update.prompt.error.action"), t), "error");
    } finally {
      setUpdateFooterBusy(false);
    }
  }, [updateFooterBusy, showToast, t]);
  const updateFooterAction = resolveUpdateFooter(desktopUpdateStatus);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    return bridge.onSettingsChanged(() => void loadSettings());
  }, [loadSettings]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useRealtimeSync({
    enabled: !isDemo,
    pushEnabled: settings.realtimePushEnabled,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    isDesktop: Boolean(desktopBridge()),
    t,
    showToast,
    onRefresh: silentRefresh,
    onSettingsChanged: loadSettings,
  });
  // Defensive: a read/unread toggle whose request hangs would otherwise leave
  // its id in the in-flight set, pinning the optimistic seen state on top of
  // every later poll. Dropping it on unmount means a fresh mount starts from
  // server truth.
  useEffect(() => {
    const seenMutationIdsRefCopy = seenMutationIdsRef;
    return () => {
      seenMutationIdsRefCopy.current.clear();
    };
  }, []);
  useEffect(() => {
    if (isDemo || !pendingMoveVerificationKey) return undefined;
    const pendingIds = pendingMoveVerificationKey.split("|").filter(Boolean);
    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    // A move that never reaches a settled, non-pending state — most commonly a
    // message deleted on the server so `api.message` 404s and `allSettled`
    // rejects forever — must not poll indefinitely. After this many attempts
    // the id is dropped so the server snapshot (and a later poll) is the
    // authority again instead of a stale "moving" row pinning the list.
    const maxAttempts = 10;

    const verifyPendingMoves = async () => {
      const results = await Promise.allSettled(pendingIds.map(async (id) => ({ id, message: await api.message(id) })));
      if (cancelled) return;
      const resolvedIds = new Set(results.flatMap((result) =>
        result.status === "fulfilled"
          && result.value.message.id === result.value.id
          && result.value.message.movePending === false
          ? [result.value.id]
          : []
      ));
      if (resolvedIds.size) {
        setPendingMoveVerifications((current) => current.filter((id) => !resolvedIds.has(id)));
        replacePendingArchiveMoves(pendingArchiveMovesRef.current.filter((move) => !resolvedIds.has(move.id)));
        void load({ silent: true });
      }
      if (cancelled || resolvedIds.size === pendingIds.length) return;
      attempt += 1;
      if (attempt >= maxAttempts) {
        // Give up cleanly: stop polling and stop treating these ids as
        // in-flight, then refresh silently so the server's truth wins.
        setPendingMoveVerifications((current) => current.filter((id) => !pendingIds.includes(id)));
        replacePendingArchiveMoves(pendingArchiveMovesRef.current.filter((move) => !pendingIds.includes(move.id)));
        void load({ silent: true });
        return;
      }
      const delay = Math.min(5_000, 750 * (2 ** Math.min(attempt, 3)));
      timer = window.setTimeout(() => void verifyPendingMoves(), delay);
    };

    timer = window.setTimeout(() => void verifyPendingMoves(), 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load, pendingMoveVerificationKey, replacePendingArchiveMoves]);
  useEffect(() => {
    if (isDemo || !submissionStatusRefreshIdsKey || !accountIdsKey) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const targetAccounts = accounts;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      await refreshSubmissions(targetAccounts, { silent: true });
      if (!cancelled && attempts < 12) timer = window.setTimeout(() => void poll(), 1_250);
    };
    timer = window.setTimeout(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accountIdsKey, accounts, refreshSubmissions, submissionStatusRefreshIdsKey]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.action ? 6000 : toast.kind === "warning" ? 9000 : toast.kind === "error" ? 6000 : 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // Floating-UI tooltips: a single reused bubble positioned by
  // @floating-ui/dom. flip() turns the bubble over when there is no room on
  // the preferred side and shift() nudges it along the axis, with the app
  // frame as the collision boundary �?so bubbles stay fully inside the
  // application surface, not just the browser viewport. JavaScript only wires
  // hover events, sets the label and hides the bubble on leave; all collision
  // math is delegated to the library. Tooltips are deliberately hover-only:
  // showing them on focus would leave a bubble visible whenever a dialog
  // opens (its first control is often the close button).
  useEffect(() => {
    const tooltip = document.createElement("div");
    tooltip.className = "nami-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    const frame = document.querySelector(".app-frame") ?? undefined;
    let positionRequest = 0;
    const show = (host: HTMLElement) => {
      const request = ++positionRequest;
      tooltip.textContent = host.getAttribute("data-tooltip") ?? "";
      tooltip.classList.add("visible");
      void computePosition(host, tooltip, {
        strategy: "fixed",
        placement: "top",
        middleware: [
          offset(8),
          flip({ boundary: frame, padding: 6 }),
          shift({ boundary: frame, padding: 6 }),
        ],
      }).then(({ x, y }) => {
        if (request !== positionRequest) return; // a newer hover superseded us
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
      });
    };
    const hide = () => {
      positionRequest += 1;
      tooltip.classList.remove("visible");
    };
    const over = (event: Event) => {
      const target = event.target as HTMLElement | null;
      // Use closest() to find the tooltip host, since the mouse may enter
      // a child element (SVG icon, span) inside the button.
      const host = target?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (host) show(host);
    };
    const out = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const host = target?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (!host) return;
      // Only hide when the mouse actually leaves the tooltip host, not when
      // moving between child elements (icon �?background).
      const related = (event as MouseEvent).relatedTarget as HTMLElement | null;
      if (related && host.contains(related)) return;
      hide();
    };
    // Clicking a tooltip host often removes it from the DOM (e.g. the reader
    // back button), and no mouseout fires for a removed element �?the bubble
    // would linger. Hiding on any pointer press is a cheap, reliable escape.
    const press = () => {
      if (tooltip.classList.contains("visible")) hide();
    };
    document.addEventListener("mouseover", over, true);
    document.addEventListener("mouseout", out, true);
    document.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("mouseover", over, true);
      document.removeEventListener("mouseout", out, true);
      document.removeEventListener("pointerdown", press, true);
      tooltip.remove();
    };
  }, []);

  const filteredMessages = useMemo(() => {
    const base = messages.filter((message) => matchesServerMessageQuery(
      message,
      accounts,
      { accountId: selectedAccount, folder: selectedFolder, search: query, messageView: view, searchScope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before },
      unreadViewRecentlyReadIds,
    ) && (!filterAttachments || message.hasAttachments));
    return sortMessages(base, sortOrder, {
      messages: base,
      accountEmails: new Set(accounts.map((account) => account.email.toLowerCase())),
      now: Date.now(),
    });
  }, [accounts, attachmentKindFilter, dateBounds, filterAttachments, messages, query, selectedAccount, selectedFolder, sortOrder, unreadViewRecentlyReadIds, view]);

  const threadGroups = useMemo(() => groupMessagesByThread(filteredMessages), [filteredMessages]);
  const threadById = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const group of threadGroups) {
      for (const message of group.messages) map.set(message.id, group.messages);
    }
    return map;
  }, [threadGroups]);

  // Virtualize the message list so only the visible window (plus overscan) is
  // mounted. The virtualizer itself lives inside MessageList so scroll frames
  // re-render only the list, not this whole tree.

  // Pins the reading position once a background merge has been applied; runs
  // before the browser paints, so the correction is never visible. Skipped
  // when the user scrolled during the fetch (they took over) or when the
  // anchor row disappeared from the list.
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (!anchor) return;
    const viewport = messageListRef.current;
    const node = messageButtonRefs.current.get(anchor.id);
    if (!viewport || !node || !node.isConnected || Math.abs(viewport.scrollTop - anchor.topCaptured) > 24) return;
    const viewportRect = viewport.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    viewport.scrollTop = rect.top - viewportRect.top + viewport.scrollTop - anchor.offset;
  }, [filteredMessages]);

  // Right after an account is added the server returns as soon as the
  // credentials are verified while the first mailbox sync continues in the
  // background. The immediate reload makes the account show up right away and
  // a couple of scheduled refreshes pick up its folders/messages as the sync
  // lands, without waiting for the periodic refresh interval.
  const handleAccountAdded = useCallback(async () => {
    await load();
    window.setTimeout(() => void silentRefresh(), 8_000);
    window.setTimeout(() => void silentRefresh(), 30_000);
  }, [load, silentRefresh]);

  const loadedServerMessageCount = useMemo(() => {
    if (isDemo) return filteredMessages.length;
    return view === "unread"
      ? messages.filter((message) => !message.seen || !unreadViewRecentlyReadIds.has(message.id)).length
      : messages.length;
  }, [filteredMessages, messages, unreadViewRecentlyReadIds, view]);
  const currentMessageTotal = useMemo(() => {
    if (!isDemo) return messageTotal;
    // Before the first demo load settles the dataset is still empty, which
    // already yields a zero total; prefer 0 over a null snapshot crash.
    const demo = demoDataSnapshot();
    return demo
      ? demoMessageTotal(messages, demo.createDemoAccounts(locale), {
        accountId: selectedAccount,
        folder: selectedFolder,
        search: debouncedQuery,
        messageView: view,
        searchScope,
        attachmentKind: attachmentKindFilter,
        after: dateBounds.after,
        before: dateBounds.before,
      })
      : 0;
  }, [attachmentKindFilter, dateBounds, debouncedQuery, locale, messageTotal, messages, searchScope, selectedAccount, selectedFolder, view]);
  const recentlyReadVisibleCount = useMemo(() => view === "unread"
    ? filteredMessages.filter((message) => message.seen && unreadViewRecentlyReadIds.has(message.id)).length
    : 0, [filteredMessages, unreadViewRecentlyReadIds, view]);
  const messageCountDescription = view === "unread"
    ? recentlyReadVisibleCount
      ? t("mail.count.unreadWithRetained", { count: currentMessageTotal, retained: recentlyReadVisibleCount })
      : t("mail.count.unread", { count: currentMessageTotal })
    : t("mail.count.total", { count: currentMessageTotal });
  const listToolbarStatus = query
    ? searchScope === "all"
      ? t("mail.search.resultsAll", { query })
      : t("mail.search.results", { query })
    : recentlyReadVisibleCount
      ? t("mail.unread.retained", { count: recentlyReadVisibleCount })
      : currentMessageTotal > loadedServerMessageCount
        ? t("mail.loaded", { loaded: loadedServerMessageCount, total: currentMessageTotal })
        : t("mail.recentlySynced");

  useEffect(() => {
    if (!selectedId || filteredMessages.some((message) => message.id === selectedId)) return;
    setSelectedId(null);
    setRecipientDetailsOpen(false);
  }, [filteredMessages, selectedId]);

  const loadMore = async () => {
    if (loading || loadingMoreRef.current || loadedServerMessageCount >= currentMessageTotal) return;
    loadingMoreRef.current = true;
    const requestId = loadRequestRef.current;
    try {
      const nextQuery = buildMessageQuery({
        accountId: selectedAccount,
        folder: selectedFolder,
        search: debouncedQuery,
        messageView: view,
        searchScope,
        attachmentKind: attachmentKindFilter,
        after: dateBounds.after,
        before: dateBounds.before,
        page: messagePage + 1,
      });
      const nextPage = await api.messages(nextQuery);
      if (requestId !== loadRequestRef.current) return;
      const pendingMerge = mergePendingArchiveMoves(
        nextPage.items,
        pendingArchiveMovesRef.current,
        accounts,
        { accountId: selectedAccount, folder: selectedFolder, search: debouncedQuery, messageView: view, searchScope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before },
      );
      setMessages((items) => {
        const existingIds = new Set(items.map((item) => item.id));
        return [...items, ...pendingMerge.items.filter((item) => !existingIds.has(item.id))];
      });
      setMessagePage(nextPage.page);
      setMessageTotal(Math.max(nextPage.total, pendingMerge.items.length));
    } catch (error) {
      if (requestId === loadRequestRef.current) showToast(mailErrorToastMessage(error, undefined, t), "error");
    } finally {
      loadingMoreRef.current = false;
    }
  };

  // Gmail-style infinite scroll: load the next page when the user approaches
  // the bottom of the loaded window (and after every append so a short list
  // keeps filling itself). loadMoreRef keeps the listener free of stale
  // closures.
  const loadMoreRef = useRef<() => void>(() => undefined);
  loadMoreRef.current = loadMore;

  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    const maybeLoadMore = () => {
      if (loading || loadingMoreRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) void loadMoreRef.current();
    };
    el.addEventListener("scroll", maybeLoadMore, { passive: true });
    maybeLoadMore();
    return () => el.removeEventListener("scroll", maybeLoadMore);
  }, [currentMessageTotal, filteredMessages.length, loadedServerMessageCount, loading]);

  const selected = filteredMessages.find((message) => message.id === selectedId) ?? null;
  const selectedThread = selected ? sortThreadByTimeline(threadById.get(selected.id) ?? []) : null;
  // Long conversations collapse to their first and last message in the strip;
  // the middle becomes one expand control. Collapsing never hides the open
  // message, so reading an interior message shows the whole thread instead.
  const [threadCollapsedPref, setThreadCollapsedPref] = useState(true);
  const threadCollapsible = (selectedThread?.length ?? 0) > 4;
  const threadCollapsed = threadCollapsible && selected !== null && shouldCollapseThread(selectedThread, selected.id, threadCollapsedPref);
  const selectedIsArchived = selected ? isArchivedMessage(selected, accounts) : false;
  // The "not spam" recovery action only applies while reading inside the
  // account's SPECIAL-USE Junk folder.
  const selectedIsInJunk = selected
    ? accounts.find((account) => account.id === selected.accountId)?.folders.some((folder) => folder.specialUse === "\\Junk" && folder.path === selected.mailbox) ?? false
    : false;
  const selectedMovePending = selected ? selected.movePending === true || pendingArchiveMoves.some((move) => move.id === selected.id) : false;
  const selectedMoveLocationUnverified = selected?.moveLocationUnverified === true;
  const selectedRemoteActionsBlocked = selectedMovePending || selectedMoveLocationUnverified;
  const selectedMoveActionLabel = selectedMovePending
    ? t("mail.action.moveRefreshing")
    : selectedMoveLocationUnverified
      ? t("mail.action.locationUnverified")
      : null;
  const translationState = useMemo<TranslationPanelState>(() => selected
    && translationSession?.messageId === selected.id
    && translationSession.targetLocale === locale
    ? translationSession.state
    : { phase: "idle" }, [locale, selected, translationSession]);
  // Whether at least one LLM provider is configured AND authorized for mail
  // content, enabling AI translation. Cloud providers require the explicit
  // "allowCloudMailContent" consent; local providers (e.g. Ollama) always qualify.
  const llmTranslationAvailable = useMemo(
    () => !isDemo && Boolean(preloadedAgentBootstrap?.providers.some(
      (provider) => provider.configured && (!provider.cloud || provider.cloudContentConsent),
    )),
    [preloadedAgentBootstrap],
  );
  const refreshTranslationAvailability = useCallback(async () => {
    const requestId = ++translationAvailabilityRequestIdRef.current;
    if (isDemo) {
      setTranslationAvailability("available");
      return;
    }
    setTranslationAvailability("checking");
    try {
      const status = await api.translationStatus();
      if (requestId === translationAvailabilityRequestIdRef.current) {
        setTranslationAvailability(status.configurationError ? "invalid" : status.enabled ? "available" : "unavailable");
      }
    } catch {
      if (requestId === translationAvailabilityRequestIdRef.current) setTranslationAvailability("unknown");
    }
  }, []);
  const selectedMessageAccount = selected ? accounts.find((account) => account.id === selected.accountId) : undefined;
  const visibleAttachments = selected?.attachments.filter((attachment) => !attachment.related) ?? [];
  const selectedAccountRecord = accounts.find((account) => account.id === selectedAccount);
  const localizedProviderName = (account: Pick<Account, "provider" | "providerName">) => providerDisplayName({ id: account.provider, name: account.providerName }, locale, t);
  const sentFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Sent");
  const draftsFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Drafts");
  const selectedFolderRecord = selectedAccountRecord?.folders.find((folder) => folder.path === selectedFolder);
const emptyMessageList = useMemo(() => (query.trim()
    ? { title: t("mail.empty.searchTitle"), description: t("mail.empty.searchDescription"), canClearSearch: true }
    : view === "unread"
      ? { title: t("mail.empty.unreadTitle"), description: t("mail.empty.unreadDescription"), canClearSearch: false }
    : view === "starred"
      ? { title: t("mail.empty.starredTitle"), description: t("mail.empty.starredDescription"), canClearSearch: false }
    : view === "archived"
      ? { title: t("mail.empty.archiveTitle"), description: t("mail.empty.archiveDescription"), canClearSearch: false }
    : view === "attachments"
      ? { title: t("mail.empty.attachmentsTitle"), description: t("mail.empty.attachmentsDescription"), canClearSearch: false }
    : selectedFolderRecord
        ? { title: t("mail.empty.folderTitle", { folder: selectedFolderRecord.name }), description: t("mail.empty.folderDescription"), canClearSearch: false }
        : { title: t("mail.empty.inboxTitle"), description: t("mail.empty.inboxDescription"), canClearSearch: false }), [query, selectedFolderRecord, t, view]);
  const { issues: accountIssues, accountsNeedingAttention, primaryAccountNeedingAttention, primaryAccountIssue, healthAlert, dismissHealthAlert } = useAccountHealth(accounts, t);
  const safeHtml = useMemo(
    () => selected?.htmlBody ? sanitizeMailHtml(selected.htmlBody, theme === "dark") : "",
    [selected?.htmlBody, theme],
  );
  // Inherit the message's branded backdrop so a translated result keeps the
  // provider-authored look instead of falling back to a plain app panel.
  const translationMailStyle = useMemo(
    () => selected?.htmlBody ? extractMailVisualStyle(selected.htmlBody) : undefined,
    [selected?.htmlBody],
  );
  const verificationCodes = useMemo(() => {
    if (!selected) return [];
    const htmlText = textFromSanitizedMailHtml(safeHtml);
    return findVerificationCodes({
      subject: selected.subject,
      body: [selected.textBody, selected.snippet, htmlText].filter(Boolean).join("\n"),
    });
  }, [safeHtml, selected]);
  useEffect(() => {
    // Translation is view-local and target-language specific. Never retain a
    // result when the user changes the selected mail or interface language.
    translationRequestIdRef.current += 1;
    setTranslationSession(null);
  }, [locale, selected?.id]);
  useEffect(() => {
    void refreshTranslationAvailability();
    return () => {
      translationAvailabilityRequestIdRef.current += 1;
    };
  }, [refreshTranslationAvailability]);
  const translateSelectedMessage = useCallback(async () => {
    if (!selected || translationState.phase === "loading") return;
    if (!state.translationTermsAccepted) {
      translationTermsPendingRef.current = "free";
      actions.setTranslationTermsOpen(true);
      return;
    }
    const messageId = selected.id;
    const targetLocale = locale;
    const previous = retainedTranslationContent(translationState);
    const requestId = ++translationRequestIdRef.current;
    translationAbortRef.current?.abort();
    const controller = new AbortController();
    translationAbortRef.current = controller;
    setTranslationSession({ messageId, targetLocale, state: { phase: "loading", ...(previous ? { previous } : {}) } });
    try {
      // HTML-bodied messages keep their markup, links, and inline styles by
      // translating the visible text nodes in place (Immersive-Translate style)
      // instead of replacing the whole body with a plain-text translation.
      if (!isDemo && selected.htmlBody) {
        const sanitized = sanitizeMailHtml(selected.htmlBody, theme === "dark");
        const template = document.createElement("template");
        template.innerHTML = sanitized;
        const segments = extractMailTextSegments(template.content);
        if (segments.length > 0) {
          const { translations } = await api.translateMessageSegments(segments.map((segment) => segment.text), targetLocale);
          for (let index = 0; index < segments.length; index++) {
            applyMailTranslation(template.content, segments[index]!.path, translations[index]!);
          }
          if (requestId !== translationRequestIdRef.current) return;
          setTranslationSession({
            messageId,
            targetLocale,
            state: {
              phase: "ready",
              // The panel preview stays plain text; the styled version lives in
              // translatedHtml and replaces the body in the reader.
              translatedText: translations.join("\n"),
              translatedHtml: template.innerHTML,
              visible: true,
            },
          });
          return;
        }
      }
      if (isDemo) {
        const demo = await ensureDemoLoaded();
        const result = demo.demoMessageTranslation(selected, targetLocale);
        if (requestId !== translationRequestIdRef.current) return;
        setTranslationSession({
          messageId,
          targetLocale,
          state: {
            phase: "ready",
            translatedText: result.translatedText,
            ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
            visible: true,
          },
        });
      } else {
        const result = await api.translateMessageStream(
          messageId,
          targetLocale,
          (partial) => {
            if (requestId !== translationRequestIdRef.current) return;
            setTranslationSession({
              messageId,
              targetLocale,
              state: { phase: "ready", translatedText: partial, visible: true, streaming: true },
            });
          },
          controller.signal,
        );
        if (requestId !== translationRequestIdRef.current) return;
        setTranslationSession({
          messageId,
          targetLocale,
          state: {
            phase: "ready",
            translatedText: result.translatedText,
            ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
            visible: true,
          },
        });
      }
    } catch (error) {
      if (requestId !== translationRequestIdRef.current) return;
      // User cancelled the streaming translation �?keep any partial result
      // already shown instead of surfacing an error.
      if (controller.signal.aborted) {
        setTranslationSession((current) => {
          if (!current || current.messageId !== messageId || current.targetLocale !== targetLocale) return current;
          if (current.state.phase === "ready" && current.state.streaming) {
            return { ...current, state: { ...current.state, streaming: false } };
          }
          return previous
            ? { messageId, targetLocale, state: { phase: "ready", ...previous, visible: true } }
            : null;
        });
        return;
      }
      const llmAvailable = error instanceof ApiError && error.llmAvailable;
      setTranslationSession({
        messageId,
        targetLocale,
        state: { phase: "error", message: translationErrorMessage(error, t), ...(previous ? { previous } : {}), ...(llmAvailable ? { llmAvailable } : {}) },
      });
    }
  }, [locale, selected, t, theme, translationState, state.translationTermsAccepted]);
  const translateSelectedMessageWithLlm = useCallback(async () => {
    if (!selected || translationState.phase === "loading") return;
    if (!state.translationTermsAccepted) {
      translationTermsPendingRef.current = "llm";
      actions.setTranslationTermsOpen(true);
      return;
    }
    const messageId = selected.id;
    const targetLocale = locale;
    const previous = retainedTranslationContent(translationState);
    // Mirror the server-side size guard so oversized messages fail fast
    // without ever sending their body to an LLM provider.
    const bodyText = selected.textBody.trim();
    const translatableLength = bodyText
      ? bodyText.length
      : selected.htmlBody.trim()
        ? selected.htmlBody.trim().replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").length
        : 0;
    if (translatableLength > MAX_LLM_TRANSLATION_TEXT_LENGTH) {
      setTranslationSession({ messageId, targetLocale, state: { phase: "error", message: t("translation.error.requestTooLarge"), ...(previous ? { previous } : {}) } });
      return;
    }
    const requestId = ++translationRequestIdRef.current;
    llmTranslationAbortRef.current?.abort();
    const controller = new AbortController();
    llmTranslationAbortRef.current = controller;
    setTranslationSession({ messageId, targetLocale, state: { phase: "loading", ...(previous ? { previous } : {}) } });
    try {
      const providers = isDemo ? { items: [], defaultProviderId: null } : await api.agentProviders();
      const configured = providers.items.filter((p) => p.configured);
      const provider = configured.find((p) => p.id === providers.defaultProviderId) ?? configured[0];
      if (!provider) {
        if (requestId !== translationRequestIdRef.current) return;
        setTranslationSession({ messageId, targetLocale, state: { phase: "error", message: t("translation.llmNoProvider"), ...(previous ? { previous } : {}) } });
        return;
      }
      const result = await api.translateMessageWithLlmStream(
        messageId,
        targetLocale,
        provider.id,
        undefined,
        (partial) => {
          if (requestId !== translationRequestIdRef.current) return;
          setTranslationSession({
            messageId,
            targetLocale,
            state: { phase: "ready", translatedText: partial, visible: true, streaming: true },
          });
        },
        controller.signal,
      );
      if (requestId !== translationRequestIdRef.current) return;
      setTranslationSession({
        messageId, targetLocale,
        state: { phase: "ready", translatedText: result.translatedText, visible: true },
      });
    } catch (error) {
      if (requestId !== translationRequestIdRef.current) return;
      // User cancelled the LLM translation �?restore any previous result
      // instead of surfacing an error.
      if (controller.signal.aborted) {
        setTranslationSession((current) => {
          if (!current || current.messageId !== messageId || current.targetLocale !== targetLocale) return current;
          if (current.state.phase === "ready" && current.state.streaming) {
            return { ...current, state: { ...current.state, streaming: false } };
          }
          return previous
            ? { messageId, targetLocale, state: { phase: "ready", ...previous, visible: true } }
            : null;
        });
        return;
      }
      setTranslationSession({
        messageId, targetLocale,
        state: { phase: "error", message: llmTranslationErrorMessage(error, t), ...(previous ? { previous } : {}) },
      });
    } finally {
      if (llmTranslationAbortRef.current === controller) llmTranslationAbortRef.current = null;
    }
  }, [locale, selected, t, translationState, state.translationTermsAccepted]);
  const showSelectedTranslation = useCallback(() => {
    setTranslationSession((current) => {
      if (!selected || !current || current.messageId !== selected.id || current.targetLocale !== locale || current.state.phase !== "ready") {
        return current;
      }
      return { ...current, state: { ...current.state, visible: true } };
    });
  }, [locale, selected]);
  const hideSelectedTranslation = useCallback(() => {
    setTranslationSession((current) => {
      if (!selected || !current || current.messageId !== selected.id || current.targetLocale !== locale || current.state.phase !== "ready") {
        return current;
      }
      return { ...current, state: { ...current.state, visible: false } };
    });
  }, [locale, selected]);
  const cancelTranslation = useCallback(() => {
    translationAbortRef.current?.abort();
    translationAbortRef.current = null;
    llmTranslationAbortRef.current?.abort();
    llmTranslationAbortRef.current = null;
  }, []);
  const acceptTranslationTerms = useCallback(() => {
    try { localStorage.setItem("nami-mail:translation-terms-accepted", "1"); } catch { /* localStorage may be unavailable */ }
    // Also set a cookie so the acceptance survives port changes across restarts
    // (Chromium shares cookies across ports on the same domain).
    try { document.cookie = "nami-mail-translation-terms=1; max-age=31536000; path=/; SameSite=Lax"; } catch { /* cookie may be unavailable */ }
    actions.setTranslationTermsAccepted(true);
    actions.setTranslationTermsOpen(false);
    const pending = translationTermsPendingRef.current;
    translationTermsPendingRef.current = null;
    if (pending === "free") void translateSelectedMessage();
    else if (pending === "llm") void translateSelectedMessageWithLlm();
  }, [translateSelectedMessage, translateSelectedMessageWithLlm]);
  const declineTranslationTerms = useCallback(() => {
    actions.setTranslationTermsOpen(false);
    const pending = translationTermsPendingRef.current;
    translationTermsPendingRef.current = null;
    if (!pending) {
      if (window.namiDesktop?.quit) window.namiDesktop.quit();
      else window.close();
    }
  }, []);
  const copyDetectedVerificationCode = useCallback(async (code: string) => {
    const copied = await copyVerificationCodeToClipboard(code);
    showToast(copied ? t("mail.verification.copied", { code }) : t("mail.verification.copyFailed"), copied ? "success" : "error");
  }, [showToast, t]);

  const applyLocalSeenChange = useCallback((message: Message, nextSeen: boolean) => {
    if (message.seen === nextSeen) return;
    setMessages((items) => {
      const next = applyMessageSeenChange(accounts, items, stats, message.id, nextSeen).messages;
      messagesRef.current = next;
      return next;
    });
    setAccounts((items) => applyMessageSeenChange(items, [message], stats, message.id, nextSeen).accounts);
    setStats((current) => applyMessageSeenChange(accounts, [message], current, message.id, nextSeen).stats);
    if (viewRef.current === "unread") setMessageTotal((total) => Math.max(0, total + (nextSeen ? -1 : 1)));
  }, [accounts, stats]);

  const openMessage = useCallback(async (message: Message) => {
    const account = accounts.find((item) => item.id === message.accountId);
    const isDraft = account?.folders.some((folder) => folder.path === message.mailbox && folder.specialUse === "\\Drafts");
    if (isDraft) {
      setSelectedId(null);
      setRecipientDetailsOpen(false);
      let attachments: OutboundAttachment[] = [];
      if (!isDemo) {
        try {
          attachments = (await api.draftOutboundAttachments(message.id)).items;
          if (!attachments.length && message.attachments.some((attachment) => !attachment.related)) {
            attachments = (await api.importDraftOutboundAttachments(message.id)).items;
          }
        } catch (error) {
          showToast(mailErrorToastMessage(error, t("mail.error.readDraftAttachments"), t), "error");
        }
      }
      actions.openCompose({
        accountId: message.accountId,
        to: message.to.map((recipient) => recipient.address).filter(Boolean).join(", "),
        cc: message.cc.map((recipient) => recipient.address).filter(Boolean).join(", "),
        subject: message.subject,
        text: message.textBody || message.snippet,
        inReplyTo: message.inReplyTo ?? undefined,
        references: message.references,
        sourceDraftId: message.id,
        attachments,
      });
      return;
    }
    lastOpenedMessageIdRef.current = message.id;
    setSelectedId(message.id);
    setRecipientDetailsOpen(false);
    setReaderMoreOpen(false);
    if (!message.seen && !seenMutationIdsRef.current.has(message.id)) {
      seenMutationIdsRef.current.add(message.id);
      updateUnreadViewRecentlyRead(message, true);
      applyLocalSeenChange(message, true);
      if (isDemo) {
        seenMutationIdsRef.current.delete(message.id);
      } else {
        void api.markSeen(message.id, true).catch((error: unknown) => {
          const readMessage = { ...message, seen: true, flags: [...new Set([...message.flags, "\\Seen"])] };
          updateUnreadViewRecentlyRead(readMessage, false);
          applyLocalSeenChange(readMessage, false);
          showToast(t("mail.error.markRead", { message: mailErrorToastMessage(error, t("mail.error.markReadFallback"), t) }), "error");
        }).finally(() => {
          seenMutationIdsRef.current.delete(message.id);
        });
      }
    }
  }, [accounts, applyLocalSeenChange, actions.openCompose, showToast, t, updateUnreadViewRecentlyRead]);

  const closeReader = useCallback((restoreFocus = false) => {
    const messageId = lastOpenedMessageIdRef.current;
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    setReaderMoreOpen(false);
    if (!restoreFocus || !messageId) return;
    window.requestAnimationFrame(() => messageButtonRefs.current.get(messageId)?.focus());
  }, []);

  useEffect(() => {
    if (!selectedId || !isCompactMailLayout()) return;
    const frame = window.requestAnimationFrame(() => readerTitleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  useEffect(() => {
    if (!readerMoreOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (readerMoreRef.current?.contains(event.target as Node)) return;
      setReaderMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReaderMoreOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [readerMoreOpen]);

  // The compact sort/filter panel behaves like the other popovers: close on
  // outside click and Escape.
  useEffect(() => {
    if (!filterPanelOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (listToolbarRef.current?.contains(event.target as Node)) return;
      setFilterPanelOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterPanelOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterPanelOpen]);

  // Auto-focus the search input once the box expands.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Collapse the header search box on outside click or Escape.
  useEffect(() => {
    if (!searchOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (searchWrapRef.current?.contains(event.target as Node)) return;
      setSearchOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [searchOpen]);

  const openReply = useCallback(() => {
    if (!selected) return;
    const reply = buildReplyDraft(selected, [...accounts.map((account) => account.email), selected.accountEmail]);
    actions.openCompose({
      accountId: selected.accountId,
      to: reply.to.join(", "),
      cc: reply.cc.join(", "),
      subject: reply.subject,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
      text: replyBody(selected, accounts, locale, t, safeHtml),
    });
  }, [accounts, locale, actions.openCompose, safeHtml, selected, t]);

  const openReplyAll = useCallback(() => {
    if (!selected) return;
    const reply = buildReplyDraft(selected, [...accounts.map((account) => account.email), selected.accountEmail], true);
    actions.openCompose({
      accountId: selected.accountId,
      to: reply.to.join(", "),
      cc: reply.cc.join(", "),
      subject: reply.subject,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
      text: replyBody(selected, accounts, locale, t, safeHtml),
    });
  }, [accounts, locale, actions.openCompose, safeHtml, selected, t]);

  const openForward = useCallback(() => {
    if (!selected) return;
    const forward = buildForwardDraft(
      selected,
      selected.textBody || textFromSanitizedMailHtml(safeHtml) || selected.snippet,
    );
    const signature = accounts.find((account) => account.id === selected.accountId)?.signature ?? "";
    actions.openCompose({
      accountId: selected.accountId,
      to: forward.to.join(", "),
      cc: forward.cc.join(", "),
      subject: forward.subject,
      text: signature.trim() ? `${forward.text}\n\n${signature.trim()}` : forward.text,
    });
  }, [accounts, actions.openCompose, safeHtml, selected]);

  const moveSelectedMessage = async (target: MoveTarget) => {
    if (!selected || selectedRemoteActionsBlocked || (target === "archive" && selectedIsArchived)) return;
    // A second write while the account has an operation in flight is queued
    // server-side (the request waits for the account write slot); surface
    // that instead of silently dropping the click.
    if (messageAction || messageFlagging || batchBusy) showToast(t("mail.action.queued"), "info");
    // A response started before this confirmed MOVE still describes the
    // source mailbox. Keep it from replacing the local destination state.
    if (!isDemo) loadRequestRef.current += 1;
    const requestAtStart = loadRequestRef.current;
    setMessageAction(target);
    let revert = (): void => undefined;
    try {
      const currentQuery: MessageListQuery = {
        accountId: selectedAccount,
        folder: selectedFolder,
        search: debouncedQuery,
        messageView: view,
        searchScope,
        attachmentKind: attachmentKindFilter,
        after: dateBounds.after,
        before: dateBounds.before,
      };
      const destination = demoMoveDestination(accounts, selected.accountId, target);
      // Optimistic: predict the destination with the same folder resolution
      // the server uses, then apply the move locally before the round-trip.
      const optimisticSnapshot = destination && destination !== selected.mailbox
        ? applyMessageMove(accounts, [selected], stats, selected.id, destination).messages[0]
        : undefined;
      const optimisticAccounts = optimisticSnapshot
        ? applyMessageMove(accounts, [selected], stats, selected.id, destination).accounts
        : null;
      const optimisticStats = optimisticSnapshot
        ? applyMessageMove(accounts, [selected], stats, selected.id, destination).stats
        : null;
      let wasIncluded = false;
      let remainsIncluded = false;
      if (optimisticSnapshot) {
        wasIncluded = matchesServerMessageQuery(selected, accounts, currentQuery);
        remainsIncluded = matchesServerMessageQuery(optimisticSnapshot, accounts, currentQuery);
        // Sync the ref synchronously (like load) so a fast failure can gate
        // its rollback on the exact optimistic state it must reverse.
        messagesRef.current = applyMessageMove(accounts, messagesRef.current, stats, selected.id, destination).messages;
        setMessages(messagesRef.current);
        setAccounts((items) => applyMessageMove(items, [selected], stats, selected.id, destination).accounts);
        setStats((current) => applyMessageMove(accounts, [selected], current, selected.id, destination).stats);
        setMessageTotal((total) => nextMessageTotalForMove(total, wasIncluded, remainsIncluded));
      }
      revert = () => {
        if (!optimisticSnapshot || !optimisticAccounts || !optimisticStats) return;
        // A reload that landed mid-flight already holds server truth (the
        // message restored at its source); leave it alone in that case.
        if (!messagesRef.current.some((item) => item.id === selected.id && item.mailbox === destination)) return;
        const restored = revertMessageMove(optimisticAccounts, messagesRef.current, optimisticStats, selected, destination);
        messagesRef.current = restored.messages;
        setMessages(restored.messages);
        setAccounts(restored.accounts);
        setStats(restored.stats);
        if (loadRequestRef.current === requestAtStart) {
          setMessageTotal((total) => nextMessageTotalForMove(total, remainsIncluded, wasIncluded));
        }
      };
      const move = isDemo
        ? { destination, uid: undefined, refreshPending: false, uncertain: false, ok: true, locationUnverified: false }
        : await api.moveMessage(selected.id, target);
      if (move.uncertain) {
        // The provider connection ended after the command was issued: restore
        // the source state; the durable server intent resolves from protocol
        // evidence during the background refresh.
        revert();
        setSelectedId(null);
        setPendingMoveVerifications((current) => current.includes(selected.id) ? current : [...current, selected.id]);
        void load({ silent: true });
        showToast(t("mail.action.moveChecking"), "info");
        return;
      }
      if (!move.ok) {
        revert();
        showToast(t("mail.error.move"), "error");
        return;
      }
      if (optimisticSnapshot && move.destination === destination) {
        // Confirmed: refine the optimistic copy with the server's mapped UID
        // and any pending/location state.
        const refined = applyMessageMoveConfirmation(messagesRef.current, selected.id, move.uid, move.refreshPending, move.locationUnverified);
        messagesRef.current = refined;
        setMessages(refined);
      } else if (!optimisticSnapshot && move.destination && move.destination !== selected.mailbox) {
        // No predictable destination (e.g. the provider exposes no archive
        // folder locally): apply the move only after the server confirms it.
        setMessages((items) => {
          const next = applyMessageMove(accounts, items, stats, selected.id, move.destination, move.uid, move.refreshPending, move.locationUnverified).messages;
          messagesRef.current = next;
          return next;
        });
        setAccounts((items) => applyMessageMove(items, [selected], stats, selected.id, move.destination, move.uid, move.refreshPending, move.locationUnverified).accounts);
        setStats((current) => applyMessageMove(accounts, [selected], current, selected.id, move.destination, move.uid, move.refreshPending, move.locationUnverified).stats);
      }
      const movedSnapshot = optimisticSnapshot ?? applyMessageMove(
        accounts,
        [selected],
        stats,
        selected.id,
        move.destination,
        move.uid,
        move.refreshPending,
        move.locationUnverified,
      ).messages[0];
      if (movedSnapshot) {
        if (!optimisticSnapshot) {
          const fallbackWasIncluded = matchesServerMessageQuery(selected, accounts, currentQuery);
          const fallbackRemainsIncluded = matchesServerMessageQuery(movedSnapshot, accounts, currentQuery);
          setMessageTotal((total) => nextMessageTotalForMove(total, fallbackWasIncluded, fallbackRemainsIncluded));
        }
        if (!isDemo && target === "archive" && move.refreshPending) {
          replacePendingArchiveMoves([
            ...pendingArchiveMovesRef.current.filter((pending) => pending.id !== selected.id),
            { id: selected.id, accountId: selected.accountId, destination: move.destination, snapshot: movedSnapshot },
          ]);
        }
        if (!isDemo && move.refreshPending) {
          setPendingMoveVerifications((current) => current.includes(selected.id) ? current : [...current, selected.id]);
        }
      }
      if (unreadViewRecentlyReadIdsRef.current.has(selected.id)) {
        const nextRecentlyRead = new Set(unreadViewRecentlyReadIdsRef.current);
        nextRecentlyRead.delete(selected.id);
        unreadViewRecentlyReadIdsRef.current = nextRecentlyRead;
        setUnreadViewRecentlyReadIds(nextRecentlyRead);
      }
      if (move.locationUnverified && target === "archive") {
        // The server confirmed the archive move, but no stable remote UID is
        // available. Keep the user in the retained local snapshot instead of
        // leaving the only explanation behind a transient toast.
        setView("archived");
        setSelectedFolder("");
        setQuery("");
        setDebouncedQuery("");
        setSelectedId(selected.id);
      } else {
        setSelectedId(null);
      }
      showToast(
        move.locationUnverified
          ? t("mail.action.movedLocationUnverified")
          : move.refreshPending
          ? t("mail.action.moveRefreshing")
          : t(moveActionKey(target, false)),
        move.refreshPending || move.locationUnverified ? "info" : "success",
      );
      if (!isDemo && !move.refreshPending) void load({ silent: true });
    } catch (error) {
      revert();
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      setMessageAction(null);
    }
  };

  const applyBatchSeenChange = useCallback((ids: readonly string[], seen: boolean) => {
    const result = applyBatchSeenChangeState(accounts, messages, stats, ids, seen);
    messagesRef.current = result.messages;
    setMessages(result.messages);
    setAccounts(result.accounts);
    setStats(result.stats);
    if (viewRef.current === "unread" && result.changedCount) {
      setMessageTotal((total) => Math.max(0, total + (seen ? -result.changedCount : result.changedCount)));
    }
  }, [accounts, messages, stats]);

  const applyBatchFlaggedChange = useCallback((ids: readonly string[], flagged: boolean) => {
    setMessages((items) => {
      const selected = new Set(ids);
      const next = items.map((item) => {
        if (!selected.has(item.id) || item.flagged === flagged) return item;
        const flags = new Set(item.flags);
        if (flagged) flags.add("\\Flagged");
        else flags.delete("\\Flagged");
        return { ...item, flagged, flags: [...flags] };
      });
      messagesRef.current = next;
      return next;
    });
  }, []);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => {
      const next = !current;
      if (!next) setSelectedMessageIds(new Set());
      return next;
    });
  }, []);

  const toggleMessageSelected = useCallback((id: string) => {
    // Any manual toggle (Ctrl/Shift click included) enters selection mode and
    // exits a predicate-wide selection back to explicit ids.
    setSelectionMode(true);
    setSelectAllPaged(false);
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectMessageRange = useCallback((ids: string[]) => {
    // Shift+click range: merge the whole span into the selection. Re-entering
    // selection mode is a no-op when it is already active.
    setSelectionMode(true);
    setSelectAllPaged(false);
    setSelectedMessageIds((current) => {
      if (ids.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const selectAllVisibleMessages = useCallback(() => {
    setSelectedMessageIds(new Set(filteredMessages.map((message) => message.id)));
    // Gmail-style two-step select-all: once every loaded row is selected and
    // more matches exist on the server, the next click upgrades to the whole
    // matching view (handled server-side as a batch job).
    if (!isDemo && loadedServerMessageCount < currentMessageTotal) setSelectAllPaged(true);
  }, [currentMessageTotal, filteredMessages, loadedServerMessageCount]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
    setSelectAllPaged(false);
    setBatchJob(null);
  }, []);

  // The current view expressed as a server-side filter scope for predicate
  // batch operations. Mirrors buildMessageQuery so the job touches exactly
  // what the list shows.
  const selectionJobQuery = useMemo<BatchJobQuery | null>(() => {
    if (!selectAllPaged || isDemo) return null;
    if (searchScope === "all" && debouncedQuery.trim()) {
      // Global search selection: no account/folder/view restriction, the
      // server matches the same FTS candidate set the list shows. Kind and
      // date refinements still narrow the selection like the visible list.
      return {
        q: debouncedQuery.trim(),
        scope: "all",
        attachmentKind: attachmentKindFilter,
        after: dateBounds.after,
        before: dateBounds.before,
      };
    }
    return {
      accountId: selectedAccount === "all" ? undefined : selectedAccount,
      folder: selectedFolder || undefined,
      q: debouncedQuery || undefined,
      unread: view === "unread" ? true : undefined,
      archived: view === "archived" ? true : undefined,
      starred: view === "starred" ? true : undefined,
      snoozed: view === "snoozed" ? true : undefined,
      hasAttachments: view === "attachments" ? true : undefined,
      attachmentKind: attachmentKindFilter,
      after: dateBounds.after,
      before: dateBounds.before,
    };
  }, [attachmentKindFilter, dateBounds, debouncedQuery, searchScope, selectAllPaged, selectedAccount, selectedFolder, view]);

  // Polls a server-side batch job until it settles, then shows the real
  // outcome with an undo action. The toolbar stays interactive throughout;
  // only the poll loop and the final reconciliation reload run in the
  // background. Guards against a vanished job (server restart) and runaway
  // polling.
  const pollBatchJob = useCallback((jobId: string, opts: {
    successKey: string;
    exitOnSuccess: boolean;
  }) => {
    const startedAt = batchJobStartedAtRef.current;
    const next = async (): Promise<void> => {
      if (Date.now() - startedAt > 10 * 60_000) {
        setBatchJob(null);
        showToast(t("mail.selection.jobError"), "error");
        return;
      }
      try {
        const { job } = await api.batchJobStatus(jobId);
        if (job.status === "running") {
          setBatchJob(job);
          window.setTimeout(() => void next(), 600);
          return;
        }
        if (job.status === "failed") {
          setBatchJob(null);
          showToast(job.error ?? t("mail.selection.jobError"), "error");
          void load({ silent: true });
          return;
        }
        setBatchJob(null);
        const undoAction: ToastAction = {
          label: t("mail.selection.undo"),
          run: () => {
            showToast(t("mail.selection.undoStarted"), "info");
            void api.batchJobUndo(jobId).then(() => void load({ silent: true })).catch(() => {
              showToast(t("mail.selection.jobError"), "error");
            });
          },
        };
        if (job.updated > 0 && opts.exitOnSuccess) exitSelectionMode();
        if (job.failed) {
          showToast(
            t("mail.selection.partialFailure", { done: job.updated, failed: job.failed }),
            "error",
            job.updated > 0 ? undoAction : undefined,
          );
        } else {
          showToast(t(opts.successKey, { count: job.total }), "success", job.total > 0 ? undoAction : undefined);
        }
        void load({ silent: true });
      } catch {
        setBatchJob(null);
        showToast(t("mail.selection.jobError"), "error");
      }
    };
    void next();
  }, [exitSelectionMode, load, showToast, t]);

  const startBatchJob = useCallback((payload: BatchJobCreatePayload, opts: {
    successKey: string;
    exitOnSuccess: boolean;
  }) => {
    setBatchBusy(true);
    void api.batchJobCreate(payload).then(({ jobId }) => {
      batchJobStartedAtRef.current = Date.now();
      setBatchJob({ id: jobId, kind: payload.kind, status: "running", total: 0, done: 0, updated: 0, failed: 0, createdAt: Date.now() });
      // The job runs server-side; release the toolbar (progress comes from
      // the poll loop) so the list stays interactive.
      setBatchBusy(false);
      pollBatchJob(jobId, opts);
    }).catch((error: unknown) => {
      setBatchBusy(false);
      showToast(mailErrorToastMessage(error, t(payload.kind === "flags" ? "mail.error.batchUpdate" : "mail.error.move"), t), "error");
    });
  }, [pollBatchJob, showToast, t]);

  const batchUpdateFlags = async (patch: { seen?: boolean; flagged?: boolean }, successKey: string) => {
    const ids = [...selectedMessageIds];
    if ((!ids.length && !selectAllPaged) || !Object.keys(patch).length) return;
    if (batchBusy) showToast(t("mail.action.queued"), "info");
    // Predicate scope: server resolves every matching id behind a job.
    if (selectionJobQuery) {
      startBatchJob({ kind: "flags", patch, query: selectionJobQuery }, { successKey, exitOnSuccess: false });
      return;
    }
    setBatchBusy(true);
    if (patch.seen !== undefined) applyBatchSeenChange(ids, patch.seen);
    if (patch.flagged !== undefined) applyBatchFlaggedChange(ids, patch.flagged);
    try {
      if (!isDemo) {
        // The server caps a single batch at some message count; split large
        // selections so the whole selection is still applied.
        const CHUNK_SIZE = 100;
        let updated = 0;
        let failed = 0;
        for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
          const chunk = ids.slice(offset, offset + CHUNK_SIZE);
          const result = await api.batchUpdateMessageFlags(chunk, patch);
          updated += result.updated;
          failed += result.failed;
        }
        if (failed) {
          showToast(t("mail.selection.partialFailure", { done: updated, failed }), "error");
          void load({ silent: true });
          return;
        }
      }
      showToast(t(successKey, { count: ids.length }));
    } catch (error) {
      // The server owns the authoritative flags; reload to restore truth.
      void load({ silent: true });
      showToast(mailErrorToastMessage(error, t("mail.error.batchUpdate"), t), "error");
    } finally {
      setBatchBusy(false);
    }
  };

  const clearSearch = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    searchInputRef.current?.focus();
  }, []);

  const batchMoveMessages = async (target: MoveTarget) => {
    const ids = [...selectedMessageIds];
    if (!ids.length && !selectAllPaged) return;
    if (batchBusy) showToast(t("mail.action.queued"), "info");
    // Predicate scope: server moves every matching id behind a job.
    if (selectionJobQuery) {
      startBatchJob({ kind: "move", target, query: selectionJobQuery }, { successKey: moveActionKey(target, true), exitOnSuccess: true });
      return;
    }
    setBatchBusy(true);
    // The selection leaves the list and the toolbar immediately; failures are
    // rolled back (re-inserted and re-selected) once the server responds.
    exitSelectionMode();
    // Set when the inner settle throws so the success toast below cannot
    // overwrite the error toast on the shared toast slot.
    let settleFailed = false;
    try {
      if (isDemo) {
        setMessages((items) => {
          let next = items;
          for (const id of ids) {
            const current = next.find((item) => item.id === id);
            if (!current) continue;
            const destination = demoMoveDestination(accounts, current.accountId, target);
            next = applyMessageMove(accounts, next, stats, id, destination).messages;
          }
          messagesRef.current = next;
          return next;
        });
        setAccounts((items) => {
          let next = items;
          for (const id of ids) {
            const current = messages.find((item) => item.id === id);
            if (!current) continue;
            const destination = demoMoveDestination(accounts, current.accountId, target);
            next = applyMessageMove(next, [current], stats, id, destination).accounts;
          }
          return next;
        });
        setStats((current) => {
          let next = current;
          for (const id of ids) {
            const msg = messages.find((item) => item.id === id);
            if (!msg) continue;
            const destination = demoMoveDestination(accounts, msg.accountId, target);
            next = applyMessageMove(accounts, [msg], next, id, destination).stats;
          }
          return next;
        });
      } else {
        // Optimistic: drop the selection from the list immediately; whatever
        // the server cannot move is rolled back into the list at its sorted
        // position, re-selected, and explained in the toast.
        const selectedSet = new Set(ids);
        const snapshots = messagesRef.current.filter((item) => selectedSet.has(item.id));
        const snapshotById = new Map<string, Message>(snapshots.map((item) => [item.id, item]));
        const inViewById = new Map<string, boolean>(ids.map((id) => [id, filteredMessages.some((item) => item.id === id)]));
        const inViewCount = ids.reduce((count, id) => count + (inViewById.get(id) ? 1 : 0), 0);
        // Invalidate any in-flight reload so it cannot resurrect the removed
        // rows from pre-move server state.
        loadRequestRef.current += 1;
        const requestAtStart = loadRequestRef.current;
        messagesRef.current = messagesRef.current.filter((item) => !selectedSet.has(item.id));
        setMessages(messagesRef.current);
        if (inViewCount) setMessageTotal((total) => Math.max(0, total - inViewCount));

        const rollback = (failedIds: ReadonlySet<string>) => {
          const failed = ids
            .filter((id) => failedIds.has(id))
            .map((id) => snapshotById.get(id))
            .filter((message): message is Message => Boolean(message));
          if (failed.length) {
            setMessages((items) => {
              const next = mergeRolledBackMessages(items, failed, sortOrder);
              messagesRef.current = next;
              return next;
            });
          }
          // A reload that landed mid-flight already owns the authoritative
          // total (which still includes the failed messages); only restore
          // the optimistic decrement when it is still the live value.
          if (loadRequestRef.current === requestAtStart) {
            const restoredInView = ids.reduce((count, id) => count + (failedIds.has(id) && inViewById.get(id) ? 1 : 0), 0);
            if (restoredInView) setMessageTotal((total) => total + restoredInView);
          }
          if (failed.length) {
            setSelectionMode(true);
            setSelectedMessageIds(new Set(failedIds));
          }
        };

        // The server caps a single batch at 100 ids; split large selections
        // into chunks exactly like batchUpdateFlags so moves never fail with
        // a 400 for size alone. The counters live outside the try so the
        // catch can distinguish processed chunks from unprocessed ones.
        const CHUNK_SIZE = 100;
        let updated = 0;
        let failed = 0;
        let processed = 0;
        const failedIds = new Set<string>();
        const failureReasons: string[] = [];
        try {
          for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
            const chunk = ids.slice(offset, offset + CHUNK_SIZE);
            const result = await api.batchMoveMessages(chunk, target);
            updated += result.updated;
            failed += result.failed;
            for (const failure of result.failures ?? []) {
              failedIds.add(failure.id);
              if (failureReasons.length < 1 && failure.message) failureReasons.push(failure.message);
            }
            processed += chunk.length;
          }
          if (failedIds.size) {
            rollback(failedIds);
            const detail = failureReasons[0] ? ` — ${failureReasons[0]}` : "";
            showToast(`${t("mail.selection.partialFailure", { done: updated, failed })}${detail}`, "error");
            return;
          }
          // The list already reflects the move; reload to reconcile the
          // server-side truth (mapped UIDs, folder counts).
          void load({ silent: true });
        } catch (error) {
          // A mid-stream failure leaves earlier chunks moved server-side; roll
          // back only the unprocessed remainder plus any recorded failures,
          // then let a reload settle the rest.
          settleFailed = true;
          const unreconciled = new Set(ids.slice(processed));
          for (const id of failedIds) unreconciled.add(id);
          rollback(unreconciled);
          void load({ silent: true });
          showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
        }
      }
      if (!settleFailed) showToast(t(moveActionKey(target, true), { count: ids.length }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      setBatchBusy(false);
    }
  };

  const toggleSelectedStar = async () => {
    if (!selected || selectedRemoteActionsBlocked) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextFlagged = !selected.flagged;
    setMessageFlagging(true);
    try {
      if (!isDemo) await api.updateMessageFlags(selected.id, { flagged: nextFlagged });
      setMessages((items) => items.map((item) => {
        if (item.id !== selected.id) return item;
        const flags = new Set(item.flags);
        if (nextFlagged) flags.add("\\Flagged");
        else flags.delete("\\Flagged");
        return { ...item, flagged: nextFlagged, flags: [...flags] };
      }));
      if (view === "starred" && !nextFlagged) setSelectedId(null);
      showToast(nextFlagged ? t("mail.action.starred") : t("mail.action.unstarred"));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.updateStar"), t), "error");
    } finally {
      setMessageFlagging(false);
    }
  };

  const toggleSelectedSeen = async () => {
    if (!selected || selectedRemoteActionsBlocked || seenMutationIdsRef.current.has(selected.id)) return;
    const nextSeen = !selected.seen;
    seenMutationIdsRef.current.add(selected.id);
    setMessageFlagging(true);
    updateUnreadViewRecentlyRead(selected, nextSeen);
    applyLocalSeenChange(selected, nextSeen);
    try {
      if (!isDemo) await api.updateMessageFlags(selected.id, { seen: nextSeen });
      showToast(nextSeen ? t("mail.action.markedRead") : t("mail.action.markedUnread"));
    } catch (error) {
      const changedMessage = { ...selected, seen: nextSeen, flags: nextSeen ? [...new Set([...selected.flags, "\\Seen"])] : selected.flags.filter((flag) => flag !== "\\Seen") };
      updateUnreadViewRecentlyRead(changedMessage, selected.seen);
      applyLocalSeenChange(changedMessage, selected.seen);
      showToast(mailErrorToastMessage(error, t("mail.error.updateRead"), t), "error");
    } finally {
      seenMutationIdsRef.current.delete(selected.id);
      setMessageFlagging(false);
    }
  };

  const quickToggleStar = useCallback(async (message: Message) => {
    if (selectedRemoteActionsBlocked) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextFlagged = !message.flagged;
    setMessageFlagging(true);
    try {
      if (!isDemo) await api.updateMessageFlags(message.id, { flagged: nextFlagged });
      setMessages((items) => items.map((item) => {
        if (item.id !== message.id) return item;
        const flags = new Set(item.flags);
        if (nextFlagged) flags.add("\\Flagged");
        else flags.delete("\\Flagged");
        return { ...item, flagged: nextFlagged, flags: [...flags] };
      }));
      showToast(nextFlagged ? t("mail.action.starred") : t("mail.action.unstarred"));
    } catch (error) {
      void load({ silent: true });
      showToast(mailErrorToastMessage(error, t("mail.error.updateStar"), t), "error");
    } finally {
      setMessageFlagging(false);
    }
  }, [isDemo, load, messageAction, messageFlagging, selectedRemoteActionsBlocked, showToast, t]);

  const quickToggleSeen = useCallback(async (message: Message) => {
    if (selectedRemoteActionsBlocked) return;
    // The seen queue allows one in-flight mutation per message; a second
    // click on the same row while the first is still pending is ignored.
    if (seenMutationIdsRef.current.has(message.id)) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextSeen = !message.seen;
    seenMutationIdsRef.current.add(message.id);
    updateUnreadViewRecentlyRead(message, nextSeen);
    applyLocalSeenChange(message, nextSeen);
    try {
      if (!isDemo) await api.updateMessageFlags(message.id, { seen: nextSeen });
      showToast(nextSeen ? t("mail.action.markedRead") : t("mail.action.markedUnread"));
    } catch (error) {
      const changedMessage = { ...message, seen: nextSeen, flags: nextSeen ? [...new Set([...message.flags, "\\Seen"])] : message.flags.filter((flag) => flag !== "\\Seen") };
      updateUnreadViewRecentlyRead(changedMessage, message.seen);
      applyLocalSeenChange(changedMessage, message.seen);
      showToast(mailErrorToastMessage(error, t("mail.error.updateRead"), t), "error");
    } finally {
      seenMutationIdsRef.current.delete(message.id);
    }
  }, [applyLocalSeenChange, isDemo, messageAction, messageFlagging, selectedRemoteActionsBlocked, showToast, t, updateUnreadViewRecentlyRead]);

  const quickMoveMessage = useCallback(async (message: Message, target: MoveTarget) => {
    // The server queues a second write behind the in-flight one; surface that
    // instead of silently dropping the click.
    if (batchBusy || messageAction !== null || messageFlagging) showToast(t("mail.action.queued"), "info");
    // Keep an in-flight reload from resurrecting the row from pre-move state
    // while the optimistic apply is live.
    if (!isDemo) loadRequestRef.current += 1;
    const requestAtStart = loadRequestRef.current;
    setMessageAction(target);
    try {
      if (isDemo) {
        const destination = demoMoveDestination(accounts, message.accountId, target);
        setMessages((items) => {
          const next = applyMessageMove(accounts, items, stats, message.id, destination).messages;
          messagesRef.current = next;
          return next;
        });
        setAccounts((items) => {
          const current = messages.find((item) => item.id === message.id);
          if (!current) return items;
          const destination2 = demoMoveDestination(items, current.accountId, target);
          return applyMessageMove(items, [current], stats, message.id, destination2).accounts;
        });
        setStats((current) => {
          const msg = messages.find((item) => item.id === message.id);
          if (!msg) return current;
          const destination3 = demoMoveDestination(accounts, msg.accountId, target);
          return applyMessageMove(accounts, [msg], current, message.id, destination3).stats;
        });
      } else {
        const destination = demoMoveDestination(accounts, message.accountId, target);
        // Optimistic: map the row to its destination before the provider
        // round-trip; a failure restores the original snapshot and counts.
        const optimisticSnapshot = destination && destination !== message.mailbox
          ? applyMessageMove(accounts, [message], stats, message.id, destination).messages[0]
          : undefined;
        const optimisticAccounts = optimisticSnapshot
          ? applyMessageMove(accounts, [message], stats, message.id, destination).accounts
          : null;
        const optimisticStats = optimisticSnapshot
          ? applyMessageMove(accounts, [message], stats, message.id, destination).stats
          : null;
        if (optimisticSnapshot) {
          const wasIncluded = filteredMessages.some((item) => item.id === message.id);
          const remainsIncluded = matchesServerMessageQuery(optimisticSnapshot, accounts, { accountId: selectedAccount, folder: selectedFolder, search: query, messageView: view, searchScope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before });
          if (wasIncluded !== remainsIncluded) {
            setMessageTotal((total) => nextMessageTotalForMove(total, wasIncluded, remainsIncluded));
          }
          // Sync the ref synchronously (like load) so a fast failure can gate
          // its rollback on the exact optimistic state it must reverse.
          messagesRef.current = applyMessageMove(accounts, messagesRef.current, stats, message.id, destination).messages;
          setMessages(messagesRef.current);
          setAccounts((items) => applyMessageMove(items, [message], stats, message.id, destination).accounts);
          setStats((current) => applyMessageMove(accounts, [message], current, message.id, destination).stats);
        }
        try {
          const result = await api.moveMessage(message.id, target);
          if (!result.ok) throw new Error(t("mail.error.move"));
          void load({ silent: true });
        } catch (error) {
          if (optimisticSnapshot && optimisticAccounts && optimisticStats) {
            // A reload that landed mid-flight already holds server truth (the
            // message restored at its source); leave it alone in that case.
            if (messagesRef.current.some((item) => item.id === message.id && item.mailbox === destination)) {
              const restored = revertMessageMove(optimisticAccounts, messagesRef.current, optimisticStats, message, destination);
              messagesRef.current = restored.messages;
              setMessages(restored.messages);
              setAccounts(restored.accounts);
              setStats(restored.stats);
            }
          }
          if (loadRequestRef.current === requestAtStart && optimisticSnapshot) {
            const wasIncluded = filteredMessages.some((item) => item.id === message.id);
            const remainsIncluded = matchesServerMessageQuery(optimisticSnapshot, accounts, { accountId: selectedAccount, folder: selectedFolder, search: query, messageView: view, searchScope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before });
            if (wasIncluded !== remainsIncluded) {
              setMessageTotal((total) => nextMessageTotalForMove(total, remainsIncluded, wasIncluded));
            }
          }
          showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
          return;
        }
      }
      showToast(t(moveActionKey(target, false)));
    } catch (error) {
      void load({ silent: true });
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      setMessageAction(null);
    }
  }, [accounts, batchBusy, filteredMessages, isDemo, load, messageAction, messageFlagging, messages, query, selectedAccount, selectedFolder, showToast, stats, t, view]);

  const snoozeOptions = useMemo(() => [
    { key: "inOneHour", label: t("mail.snooze.inOneHour"), compute: () => new Date(Date.now() + 60 * 60_000) },
    { key: "tonight", label: t("mail.snooze.tonight"), compute: () => {
      const date = new Date();
      date.setHours(23, 0, 0, 0);
      if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
      return date;
    } },
    { key: "tomorrowMorning", label: t("mail.snooze.tomorrowMorning"), compute: () => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date;
    } },
    { key: "nextWeek", label: t("mail.snooze.nextWeek"), compute: () => {
      const date = new Date();
      date.setDate(date.getDate() + 7);
      date.setHours(9, 0, 0, 0);
      return date;
    } },
  ], [t]);

  useEffect(() => {
    if (!snoozeOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (snoozeRef.current?.contains(event.target as Node)) return;
      setSnoozeOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSnoozeOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [snoozeOpen]);

  const applyLocalSnooze = useCallback((messageId: string, until: string | null, previousUntil: string | null) => {
    const wasSnoozed = Boolean(previousUntil && new Date(previousUntil).getTime() > Date.now());
    const willBeSnoozed = Boolean(until && new Date(until).getTime() > Date.now());
    const current = messagesRef.current.find((item) => item.id === messageId);
    if (!current) return;
    setMessages((items) => {
      const next = items.map((item) => item.id === messageId ? { ...item, snoozedUntil: until } : item);
      messagesRef.current = next;
      return next;
    });
    if (wasSnoozed === willBeSnoozed || !isInboxMessage(current, accounts)) return;
    // Leaving the inbox for a snooze, or returning from one, adjusts the
    // unified inbox counts exactly like an archive move.
    const isSnoozing = !wasSnoozed && willBeSnoozed;
    const unseenDelta = current.seen ? 0 : isSnoozing ? -1 : 1;
    setStats((currentStats) => ({
      ...currentStats,
      messages: Math.max(0, currentStats.messages + (isSnoozing ? -1 : 1)),
      unread: Math.max(0, currentStats.unread + unseenDelta),
    }));
  }, [accounts]);

  const setSelectedSnoozed = async (untilIso: string) => {
    if (!selected || selectedRemoteActionsBlocked) return;
    const previousUntil = selected.snoozedUntil ?? null;
    setSnoozeOpen(false);
    setSnoozeCustomUntil("");
    // Optimistic: apply the local snooze before the provider round-trip; a
    // failure restores the previous state and counts.
    applyLocalSnooze(selected.id, untilIso, previousUntil);
    try {
      if (!isDemo) await api.snoozeMessage(selected.id, untilIso);
      showToast(t("mail.snooze.scheduled"));
    } catch (error) {
      applyLocalSnooze(selected.id, previousUntil, untilIso);
      showToast(mailErrorToastMessage(error, t("mail.error.snooze"), t), "error");
    }
  };

  const clearSelectedSnooze = async () => {
    if (!selected) return;
    const previousUntil = selected.snoozedUntil ?? null;
    setSnoozeOpen(false);
    // Optimistic: the row leaves the snoozed view (and the reader closes)
    // immediately; a failure restores both.
    if (viewRef.current === "snoozed") setSelectedId(null);
    applyLocalSnooze(selected.id, null, previousUntil);
    try {
      if (!isDemo) await api.clearMessageSnooze(selected.id);
      showToast(t("mail.snooze.cleared"));
    } catch (error) {
      applyLocalSnooze(selected.id, previousUntil, null);
      if (viewRef.current === "snoozed") setSelectedId(selected.id);
      showToast(mailErrorToastMessage(error, t("mail.error.snooze"), t), "error");
    }
  };

  const selectedIsSnoozed = selected ? isSnoozedMessage(selected) : false;

  const downloadAttachment = async (message: Message, attachment: MessageAttachment) => {
    if (pendingArchiveMovesRef.current.some((move) => move.id === message.id) || message.movePending) {
      showToast(t("mail.action.moveRefreshing"), "info");
      return;
    }
    if (message.moveLocationUnverified) {
      showToast(t("mail.action.locationUnverified"), "info");
      return;
    }
    if (isDemo) {
      showToast(t("mail.attachment.demoUnavailable"), "info");
      return;
    }
    const downloadKey = `${message.id}:${attachment.partId}`;
    if (attachmentDownloads[downloadKey]?.phase === "downloading") return;
    setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "downloading" } }));
    try {
      const blob = await api.downloadAttachment(message.id, attachment.partId);
      triggerBlobDownload(blob, attachment.filename);
      setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "ready" } }));
      window.setTimeout(() => {
        setAttachmentDownloads((current) => {
          if (current[downloadKey]?.phase !== "ready") return current;
          const next = { ...current };
          delete next[downloadKey];
          return next;
        });
      }, 3_600);
      showToast(t("mail.attachment.downloadStarted", { filename: attachment.filename }));
    } catch (error) {
      const detail = mailErrorMessage(error, t("mail.error.downloadAttachment"), t);
      setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "error", detail } }));
      showToast(mailErrorToastMessage(error, t("mail.error.downloadAttachment"), t), "error");
    }
  };

  const zipAllAttachments = async () => {
    if (!selected) return;
    if (selectedMovePending || selected.movePending) {
      showToast(t("mail.action.moveRefreshing"), "info");
      return;
    }
    if (selected.moveLocationUnverified) {
      showToast(t("mail.action.locationUnverified"), "info");
      return;
    }
    if (isDemo) {
      showToast(t("mail.attachment.demoUnavailable"), "info");
      return;
    }
    if (zipAllPhase === "zipping") return;
    setZipAllPhase("zipping");
    try {
      const blob = await buildAttachmentsZipBlob(visibleAttachments, (partId) => api.downloadAttachment(selected.id, partId));
      triggerBlobDownload(blob, attachmentsZipFilename(selected.subject));
      showToast(t("mail.attachment.zipStarted", { count: visibleAttachments.length }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.zipAttachments"), t), "error");
    } finally {
      setZipAllPhase("idle");
    }
  };

  const exportSelectedEml = async () => {
    if (!selected) return;
    if (selectedMovePending || selected.movePending) {
      showToast(t("mail.action.moveRefreshing"), "info");
      return;
    }
    if (selectedMoveLocationUnverified) {
      showToast(t("mail.action.locationUnverified"), "info");
      return;
    }
    if (isDemo) {
      showToast(t("mail.action.exportDemoUnavailable"), "info");
      return;
    }
    try {
      const { blob, filename } = await api.downloadMessageEml(selected.id);
      triggerBlobDownload(blob, filename);
      showToast(t("mail.action.exportStarted", { filename }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.exportEml"), t), "error");
    }
  };

  const printSelectedMessage = () => {
    if (!selected) return;
    if (isDemo) {
      showToast(t("mail.action.printDemoUnavailable"), "info");
      return;
    }
    window.print();
  };

  const exportContactVcf = () => {
    if (!selected) return;
    const card = vCardText(selected.from.name, selected.from.address);
    triggerBlobDownload(new Blob([card], { type: "text/vcard" }), exportDownloadFilename(selected.from.name, "contact", "vcf"));
    showToast(t("mail.action.exportStarted", { filename: exportDownloadFilename(selected.from.name, "contact", "vcf") }));
  };

  const exportCalendarIcs = () => {
    if (!selected) return;
    const start = new Date(selected.sentAt);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const ics = calendarEventIcs({
      summary: selected.subject || "(no subject)",
      description: selected.from.address,
      start,
      end,
      uid: `${selected.id}@nami-mail`,
    });
    const filename = exportDownloadFilename(selected.subject, "event", "ics");
    triggerBlobDownload(new Blob([ics], { type: "text/calendar" }), filename);
    showToast(t("mail.action.exportStarted", { filename }));
  };

  const openAttachmentPreview = (message: Message, attachment: MessageAttachment) => {
    if (pendingArchiveMovesRef.current.some((move) => move.id === message.id) || message.movePending) {
      showToast(t("mail.action.moveRefreshing"), "info");
      return;
    }
    if (message.moveLocationUnverified) {
      showToast(t("mail.action.locationUnverified"), "info");
      return;
    }
    if (isDemo) {
      showToast(t("mail.attachment.previewDemoUnavailable"), "info");
      return;
    }
    actions.openAttachmentPreview(message, attachment);
  };

  const removeAccountFromView = useCallback((accountId: string) => {
    const account = accounts.find((item) => item.id === accountId);
    const removesSelectedAccount = selectedAccount === accountId;
    const removesSelectedMessage = messages.some((message) => message.id === selectedId && message.accountId === accountId);
    const inboxFolders = account?.folders.filter((folder) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX") ?? [];
    const removedMessageCount = inboxFolders.reduce((total, folder) => total + folder.total, 0);
    const removedUnreadCount = inboxFolders.reduce((total, folder) => total + folder.unseen, 0);
    const removedMessageIds = new Set(messages.filter((message) => message.accountId === accountId).map((message) => message.id));
    if (removedMessageIds.size) {
      const nextRecentlyRead = new Set([...unreadViewRecentlyReadIdsRef.current].filter((id) => !removedMessageIds.has(id)));
      unreadViewRecentlyReadIdsRef.current = nextRecentlyRead;
      setUnreadViewRecentlyReadIds(nextRecentlyRead);
    }
    setAccounts((items) => items.filter((account) => account.id !== accountId));
    setMessages((items) => items.filter((message) => message.accountId !== accountId));
    setStats((value) => ({
      accounts: Math.max(0, value.accounts - 1),
      messages: Math.max(0, value.messages - removedMessageCount),
      unread: Math.max(0, value.unread - removedUnreadCount),
    }));
    if (isDemo) {
      const removedVisibleMessages = messages.filter((message) => message.accountId === accountId).length;
      setMessageTotal((total) => Math.max(0, total - removedVisibleMessages));
    } else {
      const nextAccountId = removesSelectedAccount ? "all" : selectedAccount;
      const nextFolder = removesSelectedAccount ? "" : selectedFolder;
      void load({ silent: true, accountId: nextAccountId, folder: nextFolder });
    }
    if (removesSelectedAccount) {
      setSelectedAccount("all");
      setSelectedFolder("");
    }
    if (removesSelectedMessage) {
      setSelectedId(null);
      setRecipientDetailsOpen(false);
    }
  }, [accounts, load, messages, selectedAccount, selectedFolder, selectedId]);

  const updateAccountSignatureInState = useCallback((accountId: string, signature: string) => {
    setAccounts((items) => items.map((account) => account.id === accountId ? { ...account, signature } : account));
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    void updateSettings({ theme: nextTheme }).catch((error: unknown) => {
      showToast(mailErrorToastMessage(error, t("settings.error.updateTheme"), t), "error");
    });
  };

  const testDesktopNotification = useCallback(async (testSettings: AppSettings) => {
    const bridge = desktopBridge();
    if (isDesktop && !bridge) throw new Error(t("settings.error.desktopNotificationsUnavailable"));
    const customSound = testSettings.notificationSound === "soft" || testSettings.notificationSound === "bright";
    const customSoundReady = customSound && await primeNotificationSound();
    reportCustomNotificationSoundAvailability();
    const payload = {
      title: "Nami Mail",
      body: t("settings.notifications.testBody"),
      silent: testSettings.notificationSound === "none" || customSoundReady,
    };
    if (bridge) {
      const result = await bridge.notify(payload);
      if (!result.shown) throw new Error(t("settings.error.systemNotificationsUnavailable"));
      return;
    }
    if (!("Notification" in window)) throw new Error(t("settings.error.browserNotificationsUnsupported"));
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("settings.error.notificationsPermission"));
    new Notification(payload.title, payload);
  }, [t]);

  const testNotificationSound = useCallback(async (sound: AppSettings["notificationSound"]) => {
    if (sound === "none") return;
    if (sound === "system") {
      await testDesktopNotification({ ...settings, notificationSound: sound });
      return;
    }
    const primed = await primeNotificationSound();
    reportCustomNotificationSoundAvailability();
    if (primed && playNotificationSound(sound)) return;
    desktopBridge()?.setCustomNotificationSoundReady(false);
    await testDesktopNotification({ ...settings, notificationSound: "system" });
    desktopBridge()?.setCustomNotificationSoundReady(false);
  }, [settings, testDesktopNotification]);

  const openNotifiedMessage = useCallback(async (messageId: string) => {
    if (isDemo) {
      const demo = await ensureDemoLoaded();
      const message = demo.demoMessages.find((item) => item.id === messageId);
      if (message) await openMessage(message);
      return;
    }
    try {
      const message = await api.message(messageId);
      setMessages((items) => items.some((item) => item.id === message.id) ? items : [message, ...items]);
      await openMessage(message);
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.openNew"), t), "error");
      void load({ silent: true });
    }
  }, [load, openMessage, showToast, t]);

  const chooseView = useCallback((next: MailView) => {
    viewRef.current = next;
    clearUnreadViewRecentlyRead();
    setView(next);
    setSelectedFolder("");
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    actions.closeMobileSidebar();
  }, [clearUnreadViewRecentlyRead, actions.closeMobileSidebar]);

  useEffect(() => {
    const unlockAudio = () => {
      void primeNotificationSound().then(reportCustomNotificationSoundAvailability, reportCustomNotificationSoundAvailability);
    };
    const reportAudioAvailability = () => reportCustomNotificationSoundAvailability();
    reportAudioAvailability();
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("focus", reportAudioAvailability);
    document.addEventListener("visibilitychange", reportAudioAvailability);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("focus", reportAudioAvailability);
      document.removeEventListener("visibilitychange", reportAudioAvailability);
      desktopBridge()?.setCustomNotificationSoundReady(false);
    };
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    const unsubscribeNewMail = bridge.onNewMail((notice) => {
      void silentRefresh();
      if (!notice.shouldAlert) return;
      if (notice.playCustomSound && !playNotificationSound(settings.notificationSound)) {
        bridge.setCustomNotificationSoundReady(false);
        const sender = notice.fromName || notice.fromAddress || t("mail.notification.newContact");
        void bridge.notify({
          title: notice.count === 1 ? t("mail.notification.singleTitle", { sender }) : t("mail.notification.multipleTitle", { count: notice.count }),
          body: notice.count === 1 ? notice.subject : t("mail.notification.multipleBody", { sender }),
          silent: false,
        }).catch(() => undefined);
      }
      showToast(notice.count === 1
        ? t("mail.notification.singleToast", { sender: notice.fromName || notice.fromAddress || t("mail.notification.newContact") })
        : t("mail.notification.multipleToast", { count: notice.count }));
    });
    const unsubscribeOpenMessage = bridge.onOpenMessage((messageId) => {
      void openNotifiedMessage(messageId);
    });
    const unsubscribeComposeNew = bridge.onComposeNew?.((mailtoUrl) => {
      actions.openCompose(parseMailtoUrl(mailtoUrl ?? "") ?? {});
    });
    const unsubscribeOpenInbox = bridge.onOpenInbox?.(() => {
      chooseView("inbox");
    });
    const unsubscribeAutoReply = bridge.onAutoReply?.((notice) => {
      setAutoReplyNotices((items) => {
        const key = autoReplyNoticeKey(notice);
        if (items.some((item) => autoReplyNoticeKey(item) === key)) return items;
        return [...items.slice(-4), notice];
      });
    });
    const unsubscribeConfirmationResult = bridge.onAgentConfirmationResult?.((result) => {
      if (!result.ok) return;
      // The draft was approved or rejected elsewhere (pending dialog, popup
      // cancel); a stale "awaiting approval" popup must not linger.
      setAutoReplyNotices((items) => items.filter((item) => !(item.kind === "pending" && item.confirmationId === result.confirmationId)));
    });
    return () => {
      unsubscribeNewMail();
      unsubscribeOpenMessage();
      unsubscribeComposeNew?.();
      unsubscribeOpenInbox?.();
      unsubscribeAutoReply?.();
      unsubscribeConfirmationResult?.();
    };
  }, [chooseView, actions.openCompose, openNotifiedMessage, settings.notificationSound, showToast, silentRefresh, t]);

  // A mailto link anywhere in the document (sidebar, message body, agent
  // answer) opens a pre-filled compose window instead of the OS default
  // client. Modified clicks and already-handled links pass through untouched.
  useEffect(() => {
    const handleMailtoClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.toLowerCase().startsWith("mailto:")) return;
      event.preventDefault();
      actions.openCompose(parseMailtoUrl(href) ?? {});
    };
    document.addEventListener("click", handleMailtoClick);
    return () => document.removeEventListener("click", handleMailtoClick);
  }, [actions.openCompose]);

  // Plain web sessions have no desktop bridge to push auto-reply events, so
  // poll the pending list and surface newly drafted replies as toasts. The
  // bridge-owned effect above handles the desktop runtime exclusively.
  useEffect(() => {
    if (isDemo || desktopBridge()) return undefined;
    let known = new Set<string>();
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      // A poll that outlives the 20s interval would race its successor: the
      // stale response could re-add already-known notices or prune notices the
      // fresher response just surfaced. Skip while one is still running.
      if (inFlight) return;
      inFlight = true;
      try {
        const { items } = await api.autoReplyPending();
        if (disposed) return;
        const nextKnown = new Set(items.map((item) => item.confirmationId));
        const additions = items
          .filter((item) => !known.has(item.confirmationId))
          .map((item): DesktopAutoReplyNotice => ({
            kind: "pending",
            confirmationId: item.confirmationId,
            requestId: item.requestId,
            accountId: item.accountId,
            messageId: item.messageId,
            subject: item.subject,
            fromName: item.fromName,
            fromAddress: item.fromAddress,
            sensitive: item.sensitive,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            replyPreview: item.preview.summary,
          }));
        known = nextKnown;
        if (additions.length > 0) {
          setAutoReplyNotices((current) => {
            const merged = [...current];
            for (const notice of additions) {
              if (!merged.some((item) => autoReplyNoticeKey(item) === autoReplyNoticeKey(notice))) merged.push(notice);
            }
            return merged.slice(-5);
          });
        }
        // Drafts that were resolved or expired elsewhere must not linger.
        setAutoReplyNotices((current) => current.filter((item) => item.kind === "sent" || nextKnown.has(item.confirmationId)));
      } catch {
        // Polling failures are silent; the review dialog surfaces errors.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 20_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  // Demo copy is seeded per locale; a language switch re-seeds accounts and
  // submissions so folder names, signatures and subjects follow the UI.
  useEffect(() => {
    if (!isDemo || !demoLoadedRef.current) return;
    void (async () => {
      const demo = await ensureDemoLoaded();
      setAccounts(demo.createDemoAccounts(locale));
      setMessages(demo.demoMessages);
      setStats(demo.demoStats);
      setSubmissions(sortSubmissions(demo.createDemoSubmissions(locale)));
    })();
  }, [locale]);

  // Demo mode surfaces a realistic auto-reply confirmation so the product
  // preview shows the pending-draft review card without a live agent.
  useEffect(() => {
    if (!isDemo) return;
    void (async () => {
      const demo = await ensureDemoLoaded();
      const now = Date.now();
      setAutoReplyNotices([
        {
          kind: "pending",
          confirmationId: "demo-auto-reply-confirmation",
          requestId: "demo-auto-reply-request",
          accountId: demo.createDemoAccounts(locale)[0]?.id ?? "personal",
          messageId: "demo-auto-reply-message",
          subject: "季度数据回顾与本周同步",
          fromName: "Lena Chen",
          fromAddress: "lena.chen@example.com",
          sensitive: false,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 20 * 60 * 1000).toISOString(),
          replyPreview: "收到，我会在本周内完成数据回顾并同步给你。谢谢！",
        },
      ]);
    })();
  }, [locale]);

  useEffect(() => {
    if (!isDesktopSmoke) return;
    const report = (payload: { invoked: boolean; shown?: boolean; error?: string }) => {
      document.documentElement.dataset.namiDesktopSmokeNotification = JSON.stringify(payload);
    };
    const bridge = desktopBridge();
    if (!bridge) {
      report({ invoked: false, error: "Desktop bridge is unavailable." });
      return;
    }
    void bridge.notify({
      title: "Nami Mail",
      body: "Desktop notification bridge smoke test",
      silent: true,
    }).then(
      (result) => report({ invoked: true, shown: result.shown }),
      (error: unknown) => report({
        invoked: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const decision = dialogKeydownDecision(event, {
        updatePromptOpen,
        settingsOpen: state.settingsOpen,
        calendarOpen: state.calendarOpen,
        contactsOpen: state.contactsOpen,
        templatesOpen: state.templatesOpen,
        accountsOpen: state.accountsOpen,
        composeOpen: state.composeOpen,
        addOpen: state.addOpen,
        mobileSidebar: state.mobileSidebar,
        sendingStatusOpen: state.sendingStatusOpen,
        selectedId,
        selected: Boolean(selected),
        accountsLength: accounts.length,
        filteredMessages,
      });
      if (!decision) return;
      if (decision.preventDefault) event.preventDefault();
      switch (decision.action.kind) {
        case "absorb": return;
        case "close_settings": actions.closeSettings(); return;
        case "close_calendar": actions.closeCalendar(); return;
        case "close_contacts": actions.closeContacts(); return;
        case "close_templates": actions.closeTemplates(); return;
        case "close_accounts": actions.closeAccounts(); return;
        case "close_add_account": actions.closeAddAccount(); return;
        case "close_mobile_sidebar": actions.closeMobileSidebar(); return;
        case "close_reader": closeReader(true); return;
        case "focus_search": searchInputRef.current?.focus(); return;
        case "compose": actions.openCompose(); return;
        case "add_account": actions.openAddAccount(); return;
        case "reply": openReply(); return;
        case "reply_all": openReplyAll(); return;
        case "forward": openForward(); return;
        case "open_message": void openMessage(decision.action.message); return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accounts.length, state.addOpen, state.calendarOpen, closeReader, state.composeOpen, filteredMessages, state.mobileSidebar, actions.openCompose, openForward, openMessage, openReply, openReplyAll, selected, selectedId, state.contactsOpen, state.templatesOpen, state.accountsOpen, state.sendingStatusOpen, state.settingsOpen, updatePromptOpen, actions.openAddAccount, actions.closeSettings, actions.closeCalendar, actions.closeContacts, actions.closeTemplates, actions.closeAccounts, actions.closeAddAccount, actions.closeMobileSidebar]);

  const sync = async () => {
    if (!accounts.length || syncing) return;
    clearUnreadViewRecentlyRead();
    setSyncing(true);
    try {
      if (!isDemo) {
        const targets = selectedAccount === "all" ? accounts : accounts.filter((account) => account.id === selectedAccount);
        const settled = await Promise.allSettled(targets.map((account) => api.sync(account.id)));
        await load({ silent: true });
        const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failedAccounts = settled.length - results.length;
        const synced = results.reduce((sum, result) => sum + result.synced, 0);
        const folders = results.reduce((sum, result) => sum + result.folders, 0);
        const failedFolders = results.reduce((sum, result) => sum + result.failedFolders, 0);
        const firstFailure = settled.find((result) => result.status === "rejected");
        const failureIssue = firstFailure?.status === "rejected" ? presentMailError(firstFailure.reason, t) : null;
        if (!results.length && failedAccounts) {
          throw firstFailure?.status === "rejected" ? firstFailure.reason : new Error(t("mail.sync.allFailed"));
        }
        const partialFailure = failedAccounts > 0 || failedFolders > 0;
        showToast(
          partialFailure
            ? failedAccounts
              ? t("mail.sync.partialAccounts", { synced, accounts: failedAccounts, issue: failureIssue?.title ?? "" })
              : t("mail.sync.partialFolders", { synced, folders: failedFolders })
            : t("mail.sync.completed", { synced, folders }),
          partialFailure ? "error" : "success",
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 700));
        showToast(t("mail.sync.demoRefreshed"));
      }
    } catch (error) {
      showToast(t("mail.sync.failed", { message: mailErrorToastMessage(error, undefined, t) }), "error");
    } finally {
      setSyncing(false);
    }
  };

  const retryAccountSync = useCallback(async (accountId: string) => {
    if (isDemo) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      return { ok: true, synced: 0, folders: 0, failedFolders: 0, limitReached: false };
    }
    try {
      return await api.sync(accountId);
    } finally {
      // A failed sync persists a new health code on the server. Refresh it before the caller shows the recovery path.
      try {
        await load({ silent: true });
      } catch {
        // The sync result remains the primary outcome; load already owns its non-blocking fatal state.
      }
    }
  }, [load]);

  const chooseFolder = (path: string) => {
    viewRef.current = "inbox";
    clearUnreadViewRecentlyRead();
    setSelectedFolder(path);
    setView("inbox");
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    actions.closeMobileSidebar();
  };

  return (
    <div className={`workspace-canvas${activeBackgroundUrl ? " background-active" : ""}`}>
      {activeBackgroundUrl && (
        <div
          key={activeBackgroundUrl}
          className="workspace-background"
          style={{ backgroundImage: `url("${activeBackgroundUrl}")`, opacity: backgroundOpacity }}
          aria-hidden="true"
        />
      )}
      <div className={`app-frame${isDesktop ? " desktop-app" : ""}`} data-platform={desktopPlatform}>
      <WindowBar t={t} theme={theme} onToggleTheme={toggleTheme} platform={desktopPlatform} isDesktop={isDesktop} />

      <main className={`mail-shell${selected ? " has-open-message" : ""}${agentOpen ? " has-agent-open" : ""}`} data-agent-phase={agentPhase}>
        <aside
          ref={sidebarRef}
          className={`sidebar ${state.mobileSidebar ? "open" : ""}`}
          role={state.mobileSidebar ? "dialog" : undefined}
          aria-modal={state.mobileSidebar ? true : undefined}
          aria-label={state.mobileSidebar ? t("navigation.mail") : undefined}
          tabIndex={state.mobileSidebar ? -1 : undefined}
        >
          <div className="brand-row">
            <div className="brand-mark" aria-hidden="true">
              <img className="brand-mark-image brand-mark-light" src="/brand/mark-light.png" alt="" />
              <img className="brand-mark-image brand-mark-dark" src="/brand/mark-dark.png" alt="" />
            </div>
            <div><strong>Nami Mail</strong><span>{t("app.localMailSpace")}</span></div>
            <IconButton label={t("navigation.closeMenu")} className="mobile-only" onClick={() => actions.closeMobileSidebar()}><X size={18} /></IconButton>
          </div>

          <button className="compose-button" type="button" onClick={() => { actions.closeMobileSidebar(); if (accounts.length) actions.openCompose(); else actions.openAddAccount(); }}><PenLine size={18} />{t("mail.compose")}</button>

          <nav className={`nav-section${selectedAccount === "all" && !accountsExpanded ? "" : " collapsed"}`} aria-label={t("navigation.mailViews")}>
            <button aria-pressed={view === "inbox" && !selectedFolder} className={view === "inbox" && !selectedFolder ? "active" : ""} onClick={() => chooseView("inbox")}><Inbox size={18} /><span>{t("mail.unifiedInbox")}</span><em className="sidebar-count" data-tooltip={t("mail.inboxCountTooltip")}>{sidebarCounts.inbox || ""}</em></button>
            <button aria-pressed={view === "unread"} className={view === "unread" ? "active" : ""} onClick={() => chooseView("unread")}><Mail size={18} /><span>{t("mail.unread")}</span><em className="sidebar-count" data-tooltip={t("mail.unreadCountTooltip")}>{sidebarCounts.unread || ""}</em></button>
            <button aria-pressed={view === "starred"} className={view === "starred" ? "active" : ""} onClick={() => chooseView("starred")}><Star size={18} /><span>{t("mail.starred")}</span></button>
            <button aria-pressed={view === "archived"} className={view === "archived" ? "active" : ""} onClick={() => chooseView("archived")}><Archive size={18} /><span>{t("mail.action.archive")}</span></button>
            <button aria-pressed={view === "snoozed"} className={view === "snoozed" ? "active" : ""} onClick={() => chooseView("snoozed")}><Clock size={18} /><span>{t("mail.snoozed")}</span></button>
            <button aria-pressed={view === "attachments"} className={view === "attachments" ? "active" : ""} onClick={() => chooseView("attachments")}><Paperclip size={18} /><span>{t("mail.attachments")}</span></button>
            <button className={selectedFolder === draftsFolder?.path ? "active" : ""} disabled={!draftsFolder} onClick={() => draftsFolder && chooseFolder(draftsFolder.path)}><FilePenLine size={18} /><span>{t("mail.drafts")}</span></button>
            <button className={selectedFolder === sentFolder?.path ? "active" : ""} disabled={!sentFolder} onClick={() => sentFolder && chooseFolder(sentFolder.path)}><Send size={18} /><span>{t("mail.sent")}</span></button>
          </nav>

          <div className="accounts-heading"><span>{t("mail.accounts")}</span><IconButton label={t("account.add")} onClick={() => { actions.closeMobileSidebar(); actions.openAddAccount(); }}><Plus size={16} /></IconButton></div>
          <div className="account-list" ref={accountListRef}>
            <button aria-pressed={selectedAccount === "all"} className={selectedAccount === "all" ? "active" : ""} onClick={() => { clearUnreadViewRecentlyRead(); setSelectedAccount("all"); setAccountsExpanded(false); setSelectedFolder(""); setSelectedId(null); setRecipientDetailsOpen(false); actions.closeMobileSidebar(); }}><span className="account-avatar all"><Layers3 size={14} /></span><span className="account-copy"><strong>{t("mail.allAccounts")}</strong><small>{t("mail.accountCount", { count: accounts.length })}</small></span></button>
            {accounts.map((account) => {
              const issue = accountIssues.get(account.id);
              const providerName = localizedProviderName(account);
              const freshness = formatSyncFreshness(account.lastSyncedAt, t);
              // With a single account selected, the other account rows fold
              // away so the folder list gets the room; "all accounts" stays.
              // Expanded mode shows every row again for one-tap switching.
              const collapsed = !accountsExpanded && selectedAccount !== "all" && selectedAccount !== account.id;
              return (
                <button key={account.id} aria-pressed={selectedAccount === account.id} aria-hidden={collapsed} tabIndex={collapsed ? -1 : undefined} className={`${selectedAccount === account.id ? "active" : ""}${collapsed ? " hidden" : ""}`} onClick={() => { clearUnreadViewRecentlyRead(); setSelectedAccount(account.id); setAccountsExpanded(false); setSelectedFolder(""); setSelectedId(null); setRecipientDetailsOpen(false); actions.closeMobileSidebar(); }}>
                  <CustomAvatar name={account.email} address={account.email} tone={accountTone(account.email)} className="account-avatar" />
                  <span className="account-copy"><strong>{account.email.split("@")[0]}</strong><small>{accountShowsFreshness(issue) ? t("mail.accountFreshness", { provider: providerName, freshness }) : issue!.title}</small></span>
                  <span className={`status-dot ${accountStatusDotClass(issue, account.status)}`} aria-hidden="true" />
                </button>
              );
            })}
            {!accountsExpanded && selectedAccount === "all" && accountListOverflow && !accountListAtBottom && <div className="account-list-fade" aria-hidden="true" />}
          </div>

          {(accountsExpanded || selectedAccount !== "all" || accountListOverflow) && (
            <button type="button" className={`account-list-more${accountsExpanded ? " expanded" : ""}`} aria-expanded={accountsExpanded} aria-label={accountsExpanded ? t("mail.collapseAccounts") : t("mail.expandAccounts")} onClick={() => setAccountsExpanded(!accountsExpanded)}>
              <ChevronDown size={16} />
              {accountsExpanded && <span>{t("mail.collapseAccounts")}</span>}
            </button>
          )}

          <div className={`folder-list${!accountsExpanded && selectedAccountRecord && selectedAccountRecord.folders.length > 0 ? " show" : ""}`} ref={folderListRef} style={folderListMaxHeight != null ? ({ "--folder-list-max": `${folderListMaxHeight}px` } as CSSProperties) : undefined} aria-hidden={accountsExpanded || !(selectedAccountRecord && selectedAccountRecord.folders.length > 0)}>
            {selectedAccountRecord && selectedAccountRecord.folders.length > 0 && (
              <>
                <span className="folder-title">{t("mail.folders")}</span>
                {selectedAccountRecord.folders.map((folder) => (
                  <button key={folder.path} className={selectedFolder === folder.path ? "active" : ""} aria-pressed={selectedFolder === folder.path} onClick={() => chooseFolder(folder.path)}><FolderNavigationIcon specialUse={folder.specialUse} name={folder.name} /><span>{folder.name}</span><em>{folder.unseen || ""}</em></button>
                ))}
              </>
            )}
          </div>

          <div className="sidebar-footer">
            <div><ShieldCheck size={16} /><span><strong>{t("app.localEncryption")}</strong><small>{t("app.credentialsLocal")}</small></span></div>
            <div className="sidebar-footer-actions">
              <span className="version">v{__NAMI_APP_VERSION__}</span>
              {updateFooterAction && (
                <button type="button" className="update-footer-button" disabled={updateFooterBusy || updateFooterAction.kind === "downloading"} onClick={() => void runUpdateFooterAction(updateFooterAction)}>
                  {updateFooterAction.kind === "downloading" ? (
                    <><LoaderCircle className="spin" size={13} aria-hidden="true" />{t("update.footer.downloading", { percent: updateFooterAction.percent })}</>
                  ) : updateFooterAction.kind === "install" ? (
                    <><RotateCcw size={13} aria-hidden="true" />{t("update.footer.ready")}</>
                  ) : updateFooterAction.kind === "retry" ? (
                    <><CircleAlert size={13} aria-hidden="true" />{t("update.footer.retry")}</>
                  ) : (
                    <><Download size={13} aria-hidden="true" />{t("update.footer.available", { version: desktopUpdateStatus?.targetVersion ?? "" })}</>
                  )}
                </button>
              )}
            </div>
          </div>
        </aside>

        <div className="mail-workspace">
        <section className="message-column">
          <header className="column-header">
            <IconButton label={t("navigation.openMenu")} className="mobile-only" buttonRef={mobileMenuButtonRef} onClick={() => actions.openMobileSidebar()}><Menu size={19} /></IconButton>
            <div><span className="eyebrow">{selectedAccount === "all" ? t("mail.unifiedMailbox") : selectedAccountRecord ? localizedProviderName(selectedAccountRecord).toUpperCase() : ""}</span><h1>{query.trim() ? t("mail.search.resultsTitle", { query: query.trim() }) : view === "unread" ? t("mail.unread") : view === "starred" ? t("mail.starred") : view === "archived" ? t("mail.action.archive") : view === "snoozed" ? t("mail.snoozed") : view === "attachments" ? t("mail.attachments") : selectedFolderRecord?.name || t("mail.inbox")}</h1></div>
            <div className={`search-wrap${searchOpen ? " expanded" : ""}`} ref={searchWrapRef}><IconButton label={searchOpen ? t("mail.search.collapse") : t("mail.search")} className="search-toggle" onClick={() => setSearchOpen((open) => !open)} expanded={searchOpen}><Search size={17} /></IconButton><label className="visually-hidden" htmlFor="mail-search">{t("mail.search")}</label><input id="mail-search" ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("mail.searchPlaceholder")} />{query && <IconButton label={t("mail.clearSearch")} className="search-clear" onClick={() => { setQuery(""); setDebouncedQuery(""); searchInputRef.current?.focus(); }}><X size={15} /></IconButton>}</div>
            <div className="list-filter-wrap" ref={listToolbarRef}>
              <button type="button" className={`list-filter-toggle${filterPanelOpen ? " active" : ""}`} onClick={() => setFilterPanelOpen((open) => !open)} aria-expanded={filterPanelOpen} aria-haspopup="menu" aria-label={t("mail.listFilter.menuLabel")} data-tooltip={t("mail.listFilter.menuLabel")}><ListFilter size={16} /></button>
              {filterPanelOpen && (
                <div className="list-filter-panel wide" role="menu" aria-label={t("mail.listFilter.menuLabel")}>
                  <div className="list-filter-group" role="group" aria-label={t("mail.sort.label")}>
                    <span className="list-filter-heading">{t("mail.sort.label")}</span>
                    <button type="button" role="menuitemradio" aria-checked={sortOrder === "newest"} className={`list-filter-option${sortOrder === "newest" ? " active" : ""}`} onClick={() => setSortOrder("newest")}><span>{t("mail.sort.newest")}</span>{sortOrder === "newest" && <Check size={13} className="list-filter-option-check" />}</button>
                    <button type="button" role="menuitemradio" aria-checked={sortOrder === "oldest"} className={`list-filter-option${sortOrder === "oldest" ? " active" : ""}`} onClick={() => setSortOrder("oldest")}><span>{t("mail.sort.oldest")}</span>{sortOrder === "oldest" && <Check size={13} className="list-filter-option-check" />}</button>
                    <button type="button" role="menuitemradio" aria-checked={sortOrder === "sender"} className={`list-filter-option${sortOrder === "sender" ? " active" : ""}`} onClick={() => setSortOrder("sender")}><span>{t("mail.sort.sender")}</span>{sortOrder === "sender" && <Check size={13} className="list-filter-option-check" />}</button>
                    <button type="button" role="menuitemradio" aria-checked={sortOrder === "importance"} className={`list-filter-option${sortOrder === "importance" ? " active" : ""}`} onClick={() => setSortOrder("importance")}><span>{t("mail.sort.importance")}</span>{sortOrder === "importance" && <Check size={13} className="list-filter-option-check" />}</button>
                    {sortOrder === "importance" && <span className="list-filter-option-hint">{t("mail.sort.importanceHint")}</span>}
                  </div>
                  <div className="list-filter-divider" role="separator" />
                  <div className="list-filter-group" role="group" aria-label={t("mail.filter.label")}>
                    <span className="list-filter-heading">{t("mail.filter.label")}</span>
                    <button type="button" role="menuitemradio" aria-checked={!filterAttachments} className={`list-filter-option${!filterAttachments ? " active" : ""}`} onClick={() => setFilterAttachments(false)}><span>{t("mail.filter.all")}</span>{!filterAttachments && <Check size={13} className="list-filter-option-check" />}</button>
                    <button type="button" role="menuitemradio" aria-checked={filterAttachments} className={`list-filter-option${filterAttachments ? " active" : ""}`} onClick={() => setFilterAttachments(true)}><span>{t("mail.filter.attachments")}</span>{filterAttachments && <Check size={13} className="list-filter-option-check" />}</button>
                  </div>
                  <div className="list-filter-divider" role="separator" />
                  <div className="list-filter-group" role="group" aria-label={t("mail.filter.attachmentKind")}>
                    <span className="list-filter-heading">{t("mail.filter.attachmentKind")}</span>
                    <div className="kind-chip-row" role="radiogroup" aria-label={t("mail.filter.attachmentKind")}>
                      <button type="button" role="radio" aria-checked={attachmentKindFilter === undefined} className={`kind-chip${attachmentKindFilter === undefined ? " active" : ""}`} onClick={() => setAttachmentKindFilter(undefined)}>{t("mail.filter.anyKind")}</button>
                      {attachmentKinds.map((kind) => (
                        <button key={kind} type="button" role="radio" aria-checked={attachmentKindFilter === kind} className={`kind-chip${attachmentKindFilter === kind ? " active" : ""}`} onClick={() => setAttachmentKindFilter(attachmentKindFilter === kind ? undefined : kind)}>{t(`attachment.${kind}`)}</button>
                      ))}
                    </div>
                  </div>
                  <div className="list-filter-divider" role="separator" />
                  <div className="list-filter-group" role="group" aria-label={t("mail.filter.dateRange")}>
                    <span className="list-filter-heading">{t("mail.filter.dateRange")}</span>
                    <div className="date-range-row">
                      <DatePicker key={`filter-from-${filterPanelOpen}`} mode="date" value={dateFrom} onChange={setDateFrom} className="date-range-picker" placeholder={t("mail.filter.fromDate")} aria-label={t("mail.filter.fromDate")} maxDate={dateTo || undefined} />
                      <DatePicker key={`filter-to-${filterPanelOpen}`} mode="date" value={dateTo} onChange={setDateTo} className="date-range-picker" placeholder={t("mail.filter.toDate")} aria-label={t("mail.filter.toDate")} minDate={dateFrom || undefined} />
                      {(dateFrom || dateTo) && <IconButton label={t("mail.filter.clearDates")} className="date-range-clear" onClick={() => { setDateFrom(""); setDateTo(""); }}><X size={13} /></IconButton>}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="header-actions"><span className="message-count" aria-label={messageCountDescription} data-tooltip={messageCountDescription}>{currentMessageTotal}</span><IconButton label={selectionMode ? t("mail.selection.done") : t("mail.selection.select")} className={selectionMode ? "selection-toggle active" : "selection-toggle"} onClick={toggleSelectionMode} disabled={!accounts.length}><SquareCheckBig size={17} /></IconButton><IconButton label={t("mail.compose")} className="mobile-only mobile-compose-action" onClick={() => accounts.length ? actions.openCompose() : actions.openAddAccount()}><PenLine size={17} /></IconButton>{isDesktop && <IconButton label={theme === "light" ? t("app.switchDark") : t("app.switchLight")} onClick={toggleTheme}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton>}<IconButton label={t("mail.sync.action")} onClick={() => void sync()} disabled={syncing || !accounts.length}><RefreshCw className={syncing ? "spin" : ""} size={17} /></IconButton><button ref={agentLaunchButtonRef} className="agent-launch-button" type="button" onClick={() => openAgentWorkspace()} aria-label={t("agent.open")} data-tooltip={t("agent.open")}><span className="agent-launch-mark" aria-hidden="true"><AgentMark size={19} /></span><span>{t("agent.launch")}</span></button></div>
          </header>

          {healthAlert && healthAlert.until > Date.now() && (
            <AccountHealthBanner
              until={healthAlert.until}
              issueCount={accountsNeedingAttention.length}
              problemTitle={primaryAccountNeedingAttention && primaryAccountIssue ? t("mail.accountProblem", { email: primaryAccountNeedingAttention.email, title: primaryAccountIssue.title }) : t("mail.otherAccountsAvailable")}
              onShowReasons={() => { actions.openAccounts(); dismissHealthAlert(); }}
              onExpire={dismissHealthAlert}
            />
          )}

          <div className={`list-toolbar-frame${selectionMode ? " selection-on" : ""}`}>
            <div className="list-toolbar list-status-bar">
              <span className={recentlyReadVisibleCount ? "unread-retention-note" : ""} aria-live={recentlyReadVisibleCount ? "polite" : undefined}>{listToolbarStatus}</span>
              {query.trim() && (
                <span className="search-scope-switch" role="radiogroup" aria-label={t("mail.search.scopeLabel")}>
                  <button type="button" role="radio" aria-checked={searchScope === "view"} onClick={() => setSearchScope("view")}>{t("mail.search.scopeCurrent")}</button>
                  <button type="button" role="radio" aria-checked={searchScope === "all"} onClick={() => setSearchScope("all")}>{t("mail.search.scopeAll")}</button>
                </span>
              )}
            </div>
            <div className="list-toolbar selection-toolbar" aria-hidden={!selectionMode}>
              <button className="selection-select-all" type="button" onClick={selectAllVisibleMessages} disabled={!filteredMessages.length}>{selectAllPaged ? t("mail.selection.selectAllMatching", { count: currentMessageTotal }) : t("mail.selection.selectAll")}</button>
              <span className="selection-count">{batchJob ? t("mail.selection.batchProcessing", { done: batchJob.done, total: batchJob.total || currentMessageTotal }) : batchBusy ? t("mail.selection.busy") : t("mail.selection.count", { count: selectAllPaged ? currentMessageTotal : selectedMessageIds.size })}</span>
              <div className="selection-actions">
                <IconButton label={t("mail.action.markRead")} className="selection-action" onClick={() => void batchUpdateFlags({ seen: true }, "mail.selection.markedRead")} disabled={!selectedMessageIds.size}><MailOpen size={15} /></IconButton>
                <IconButton label={t("mail.action.markUnread")} className="selection-action" onClick={() => void batchUpdateFlags({ seen: false }, "mail.selection.markedUnread")} disabled={!selectedMessageIds.size}><Mail size={15} /></IconButton>
                <IconButton label={t("mail.action.star")} className="selection-action" onClick={() => void batchUpdateFlags({ flagged: true }, "mail.selection.starred")} disabled={!selectedMessageIds.size}><Star size={15} /></IconButton>
                <IconButton label={t("mail.action.unstar")} className="selection-action" onClick={() => void batchUpdateFlags({ flagged: false }, "mail.selection.unstarred")} disabled={!selectedMessageIds.size}><Star size={15} fill="none" /></IconButton>
                <span className="toolbar-divider" aria-hidden="true" />
                <IconButton label={t("mail.action.archive")} className="selection-action" onClick={() => void batchMoveMessages("archive")} disabled={!selectedMessageIds.size}><Archive size={15} /></IconButton>
                <IconButton label={t("mail.action.reportSpam")} className="selection-action" onClick={() => void batchMoveMessages("junk")} disabled={!selectedMessageIds.size}><ShieldCheck size={15} /></IconButton>
                <IconButton label={t("mail.action.moveToTrash")} className="selection-action selection-action-danger" onClick={() => void batchMoveMessages("trash")} disabled={!selectedMessageIds.size}><Trash2 size={15} /></IconButton>
              </div>
              <button className="selection-done" type="button" onClick={exitSelectionMode} disabled={batchBusy}>{t("mail.selection.done")}</button>
            </div>
          </div>

          <MessageList
            loading={loading}
            fatalError={fatalError}
            accounts={accounts}
            messages={filteredMessages}
            selectedId={selectedId}
            selectionMode={selectionMode}
            selectedMessageIds={selectedMessageIds}
            view={view}
            unreadViewRecentlyReadIds={unreadViewRecentlyReadIds}
            threadById={threadById}
            listDensity={settings.listDensity}
            avatarGravatarEnabled={settings.avatarGravatarEnabled}
            emptyMessageList={emptyMessageList}
            messageListRef={messageListRef}
            messageButtonRefs={messageButtonRefs}
            onReconnect={load}
            onAddAccount={() => actions.openAddAccount()}
            onClearSearch={clearSearch}
            onOpenMessage={openMessage}
            onToggleSelected={toggleMessageSelected}
            onSelectRange={selectMessageRange}
            onQuickToggleStar={quickToggleStar}
            onQuickToggleSeen={quickToggleSeen}
            onQuickMoveMessage={quickMoveMessage}
          />
        </section>

        <section className={`reader-column ${selected ? "has-message" : ""}`}>
          {selected ? (
            <ErrorBoundary key={selected.id} t={t} area={t("mail.readerArea")}>
              <header className="reader-toolbar">
                <IconButton label={t("mail.reader.backToList")} className="reader-back" onClick={() => closeReader(true)}><ArrowLeft size={18} /></IconButton>
                <div className="reader-actions">
                  <IconButton label={t("mail.action.reply")} onClick={openReply}><Reply size={18} /></IconButton>
                  <IconButton label={t("mail.action.replyAll")} className="reader-action-secondary" onClick={openReplyAll}><ReplyAll size={18} /></IconButton>
                  <IconButton label={t("mail.action.forward")} className="reader-action-secondary" onClick={openForward}><Forward size={18} /></IconButton>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <IconButton label={selectedMoveActionLabel ?? (selected.seen ? t("mail.action.markUnread") : t("mail.action.markRead"))} onClick={() => void toggleSelectedSeen()} disabled={selectedRemoteActionsBlocked}>{selected.seen ? <Mail size={18} /> : <MailOpen size={18} />}</IconButton>
                  <IconButton label={selectedMoveActionLabel ?? (selected.flagged ? t("mail.action.unstar") : t("mail.action.star"))} className={selected.flagged ? "active-star" : ""} onClick={() => void toggleSelectedStar()} disabled={selectedRemoteActionsBlocked}><Star size={18} fill={selected.flagged ? "currentColor" : "none"} /></IconButton>
                  <IconButton label={selectedMoveActionLabel ?? t("mail.action.archive")} className="reader-action-secondary" onClick={() => void moveSelectedMessage("archive")} disabled={selectedRemoteActionsBlocked || selectedIsArchived}><Archive size={18} /></IconButton>
                  <IconButton label={selectedMoveActionLabel ?? t("mail.action.moveToTrash")} className="reader-action-secondary" onClick={() => void moveSelectedMessage("trash")} disabled={selectedRemoteActionsBlocked}><Trash2 size={18} /></IconButton>
                  <div className="reader-snooze" ref={snoozeRef}>
                    <IconButton label={selectedIsSnoozed ? t("mail.snooze.reschedule") : t("mail.snooze.title")} className={`reader-action-secondary${selectedIsSnoozed ? " snoozed" : ""}`} onClick={() => { setSnoozeOpen((value) => !value); setSnoozeCustomUntil(""); }} expanded={snoozeOpen} disabled={selectedRemoteActionsBlocked}><Clock size={18} /></IconButton>
                    {snoozeOpen && (
                      <div className="snooze-menu" role="menu" aria-label={t("mail.snooze.title")}>
                        {selectedIsSnoozed && selected.snoozedUntil && (
                          <>
                            <div className="snooze-current" role="status"><Clock size={14} />{t("mail.snooze.current", { until: formatFullDate(selected.snoozedUntil, locale) })}</div>
                            <button type="button" role="menuitem" onClick={() => void clearSelectedSnooze()}><X size={15} />{t("mail.snooze.clear")}</button>
                          </>
                        )}
                        {snoozeOptions.map((option) => (
                          <button key={option.key} type="button" role="menuitem" onClick={() => void setSelectedSnoozed(option.compute().toISOString())}><Clock size={15} />{option.label}</button>
                        ))}
                        <div className="snooze-custom">
                          <label htmlFor="snooze-custom-input">{t("mail.snooze.customLabel")}</label>
                          <span className="snooze-custom-controls">
                            <DatePicker mode="datetime" value={snoozeCustomUntil} onChange={setSnoozeCustomUntil} aria-label={t("mail.snooze.customLabel")} />
                            <button type="button" onClick={() => { const iso = isoFromDatetimeLocal(snoozeCustomUntil); if (iso) void setSelectedSnoozed(iso); }} disabled={!snoozeCustomUntil}>{t("common.ok")}</button>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="reader-more" ref={readerMoreRef}>
                    <IconButton label={t("mail.action.more")} className="reader-more-toggle" onClick={() => setReaderMoreOpen((value) => !value)} expanded={readerMoreOpen}><MoreHorizontal size={19} /></IconButton>
                    {readerMoreOpen && (
                      <div className="reader-more-menu" role="menu" aria-label={t("mail.action.more")}>
                        <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); openReplyAll(); }}><ReplyAll size={16} />{t("mail.action.replyAll")}</button>
                        <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); openForward(); }}><Forward size={16} />{t("mail.action.forward")}</button>
                        <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked || selectedIsArchived} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("archive"); }}><Archive size={16} />{t("mail.action.archive")}</button>
                        <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void exportSelectedEml(); }}><Download size={16} />{t("mail.action.exportEml")}</button>
                        <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); exportContactVcf(); }}><UserRound size={16} />{t("mail.action.saveVcf")}</button>
                        <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); exportCalendarIcs(); }}><CalendarArrowDown size={16} />{t("mail.action.exportIcs")}</button>
                        <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); printSelectedMessage(); }}><Printer size={16} />{t("mail.action.print")}</button>
                        {!selectedIsInJunk && (
                          <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("junk"); }}><ShieldCheck size={16} />{t("mail.action.reportSpam")}</button>
                        )}
                        {selectedIsInJunk && (
                          <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("inbox"); }}><Inbox size={16} />{t("mail.action.notSpam")}</button>
                        )}
                        <button type="button" role="menuitem" className="reader-more-danger" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("trash"); }}><Trash2 size={16} />{t("mail.action.moveToTrash")}</button>
                      </div>
                    )}
                  </div>
                  <button className="agent-launch-button" type="button" onClick={() => openAgentWorkspace()} aria-label={t("agent.open")} data-tooltip={t("agent.open")}><span className="agent-launch-mark" aria-hidden="true"><AgentMark size={19} /></span><span>{t("agent.launch")}</span></button>
                </div>
              </header>
                {selectedThread && selectedThread.length > 1 && (
                  <section className="thread-strip" aria-label={t("mail.thread.label")}>
                    <span className="thread-strip-caption">{t("mail.thread.label")}</span>
                    <div className="thread-strip-messages">
                      {threadCollapsed
                        ? (<>
                            <button key={selectedThread[0]!.id} type="button" className={`thread-strip-item ${selectedThread[0]!.id === selected.id ? "active" : ""}`} onClick={() => void openMessage(selectedThread[0]!)}>
                              <CustomAvatar name={selectedThread[0]!.from.name} address={selectedThread[0]!.from.address} tone={accountTone(selectedThread[0]!.from.address)} size="small" />
                              <span className="thread-strip-copy"><strong>{selectedThread[0]!.from.name || selectedThread[0]!.from.address}</strong><time>{formatMessageTime(selectedThread[0]!.sentAt, locale)}</time></span>
                              {!selectedThread[0]!.seen && <span className="unread-dot" aria-hidden="true" />}
                            </button>
                            <button type="button" className="thread-strip-fold" onClick={() => setThreadCollapsedPref(false)} aria-label={t("mail.thread.expand", { count: selectedThread.length - 2 })} data-tooltip={t("mail.thread.expand", { count: selectedThread.length - 2 })}>
                              <MoreHorizontal size={15} /><span>{t("mail.thread.folded", { count: selectedThread.length - 2 })}</span>
                            </button>
                            <button key={selectedThread[selectedThread.length - 1]!.id} type="button" className={`thread-strip-item ${selectedThread[selectedThread.length - 1]!.id === selected.id ? "active" : ""}`} onClick={() => void openMessage(selectedThread[selectedThread.length - 1]!)}>
                              <CustomAvatar name={selectedThread[selectedThread.length - 1]!.from.name} address={selectedThread[selectedThread.length - 1]!.from.address} tone={accountTone(selectedThread[selectedThread.length - 1]!.from.address)} size="small" />
                              <span className="thread-strip-copy"><strong>{selectedThread[selectedThread.length - 1]!.from.name || selectedThread[selectedThread.length - 1]!.from.address}</strong><time>{formatMessageTime(selectedThread[selectedThread.length - 1]!.sentAt, locale)}</time></span>
                              {!selectedThread[selectedThread.length - 1]!.seen && <span className="unread-dot" aria-hidden="true" />}
                            </button>
                          </>)
                        : selectedThread.map((threadMessage) => (
                            <button key={threadMessage.id} type="button" className={`thread-strip-item ${threadMessage.id === selected.id ? "active" : ""}`} onClick={() => void openMessage(threadMessage)}>
                              <CustomAvatar name={threadMessage.from.name} address={threadMessage.from.address} tone={accountTone(threadMessage.from.address)} size="small" />
                              <span className="thread-strip-copy"><strong>{threadMessage.from.name || threadMessage.from.address}</strong><time>{formatMessageTime(threadMessage.sentAt, locale)}</time></span>
                              {!threadMessage.seen && <span className="unread-dot" aria-hidden="true" />}
                            </button>
                          ))}
                    </div>
                    {threadCollapsible && (
                      <button type="button" className={`thread-strip-toggle${threadCollapsed ? "" : " expanded"}`} onClick={() => setThreadCollapsedPref((value) => !value)} aria-expanded={!threadCollapsed}>
                        {t(threadCollapsed ? "mail.thread.expandAll" : "mail.thread.collapse", { count: selectedThread.length })}
                      </button>
                    )}
                  </section>
                )}
                {selectedMoveLocationUnverified && <section className="move-location-notice" role="status"><CircleAlert size={18} /><div><strong>{t("mail.moveLocationUnverified.title")}</strong><p>{t("mail.moveLocationUnverified.description")}</p></div></section>}
                <div className="reader-split">
                <article className="mail-reader">
                <header className="mail-title"><span className="account-badge">{selectedMessageAccount ? localizedProviderName(selectedMessageAccount) : selected.providerName}</span><h2 ref={readerTitleRef} tabIndex={-1}>{selected.subject}</h2><div className="mail-people"><CustomAvatar name={selected.from.name} address={selected.from.address} tone={accountTone(selected.from.address)} size="large" /><div className="mail-people-copy"><strong>{selected.from.name || selected.from.address}</strong><button className="mail-recipient-toggle" type="button" data-tooltip={selected.from.address} aria-expanded={recipientDetailsOpen} onClick={() => setRecipientDetailsOpen((value) => !value)}>{t("mail.reader.toMe")} <ChevronDown className={recipientDetailsOpen ? "open" : ""} size={13} /></button>{recipientDetailsOpen && <div className="mail-recipient-details"><span>{t("compose.sender")}</span><strong>{selected.from.name ? `${selected.from.name} <${selected.from.address}>` : selected.from.address}</strong><span>{t("compose.to")}</span><strong>{selected.to.length ? selected.to.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(t("common.listSeparator")) : selected.accountEmail}</strong>{selected.cc.length > 0 && <><span>{t("compose.cc")}</span><strong>{selected.cc.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(t("common.listSeparator"))}</strong></>}</div>}</div><time>{formatFullDate(selected.sentAt, locale)}</time></div></header>
                {verificationCodes.length > 0 && (
                  <section className="verification-code-list" aria-label={t("mail.verification.detected") }>
                    {verificationCodes.map((candidate, index) => {
                      const isPrimaryVerificationCode = index === 0;
                      const sourceLabel = candidate.source === "subject" ? t("mail.verification.subject") : t("mail.verification.body");
                      return (
                        <section className={`verification-code-panel ${isPrimaryVerificationCode ? "primary" : "candidate"}`} key={`${candidate.code}:${candidate.source}`} aria-label={isPrimaryVerificationCode ? t("mail.verification.detected") : t("mail.verification.otherCandidate")}>
                          <div><span>{isPrimaryVerificationCode ? t("mail.verification.label", { source: sourceLabel }) : t("mail.verification.otherLabel", { source: sourceLabel })}</span><strong>{candidate.code}</strong></div>
                          <button className="secondary-button verification-code-copy" type="button" onClick={() => void copyDetectedVerificationCode(candidate.code)} aria-label={t("mail.verification.copyAria", { code: candidate.code })} data-tooltip={t("mail.verification.copyTooltip")}><Copy size={15} />{isPrimaryVerificationCode ? t("mail.verification.copy") : t("common.copy")}</button>
                        </section>
                      );
                    })}
                  </section>
                )}
                <TranslationPanel
                  availability={translationAvailability}
                  state={translationState}
                  llmAvailable={llmTranslationAvailable}
                  mailStyle={translationMailStyle}
                  onCheckAvailability={() => void refreshTranslationAvailability()}
                  onTranslate={() => void translateSelectedMessage()}
                  onTranslateWithLlm={() => void translateSelectedMessageWithLlm()}
                  onShow={showSelectedTranslation}
                  onHide={hideSelectedTranslation}
                  onCancel={cancelTranslation}
                />
                <div className="mail-content">
                  {selected.htmlBody
                    ? <div className="mail-html" dangerouslySetInnerHTML={{ __html: (translationState.phase === "ready" && translationState.visible && translationState.translatedHtml) ? translationState.translatedHtml : safeHtml }} />
                    : <div className="mail-text">{selected.textBody || selected.snippet}</div>}
                </div>
                {visibleAttachments.length > 0 && (
                  <section className="attachment-list" aria-label={t("mail.attachment.aria", { count: visibleAttachments.length })}>
                    <div className="attachment-list-heading"><Paperclip size={15} /><span>{t("compose.attachments")}</span><small>{t("mail.attachment.fileCount", { count: visibleAttachments.length })}</small><span className="attachment-heading-actions"><IconButton label={t("mail.attachment.downloadAllZip")} disabled={zipAllPhase === "zipping" || selectedMovePending || selected.movePending || selected.moveLocationUnverified} onClick={() => void zipAllAttachments()}>{zipAllPhase === "zipping" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}</IconButton></span></div>
                    {visibleAttachments.map((attachment) => {
                      const presentation = presentAttachment(attachment.filename, attachment.contentType, t);
                      const downloadKey = `${selected.id}:${attachment.partId}`;
                      const download = attachmentDownloads[downloadKey];
                      const isDownloading = download?.phase === "downloading";
                      const downloadDetail = isDownloading
                        ? t("mail.attachment.preparing")
                        : download?.phase === "ready"
                          ? t("mail.attachment.ready", { type: presentation.label, size: formatFileSize(attachment.size) })
                          : download?.phase === "error"
                            ? t("mail.attachment.failed", { message: download.detail ?? t("error.retry") })
                            : t("mail.attachment.detail", { type: presentation.label, size: formatFileSize(attachment.size) });
                      return (
                        <div className={`attachment-card${download?.phase ? ` is-${download.phase}` : ""}`} key={attachment.partId}>
                          <AttachmentFileIcon kind={presentation.kind} />
                          <span><strong className="truncated-tooltip" data-tooltip={attachment.filename}><span>{attachment.filename}</span></strong><small className="truncated-tooltip" aria-live="polite" data-tooltip={download?.detail}><span>{downloadDetail}</span></small></span>
                          <div className="attachment-actions">
                            {canPreviewAttachment(attachment.filename, attachment.contentType) && (
                              <IconButton label={t("mail.attachment.preview", { filename: attachment.filename })} disabled={selectedRemoteActionsBlocked} onClick={() => openAttachmentPreview(selected, attachment)}><Eye size={16} /></IconButton>
                            )}
                            <IconButton label={selectedMoveActionLabel ?? (download?.phase === "error" ? t("mail.attachment.retryDownload", { filename: attachment.filename }) : t("mail.attachment.download", { filename: attachment.filename }))} disabled={isDownloading || selectedRemoteActionsBlocked} onClick={() => void downloadAttachment(selected, attachment)}>{isDownloading ? <LoaderCircle className="spin" size={16} /> : download?.phase === "error" ? <RefreshCw size={16} /> : <Download size={16} />}</IconButton>
                          </div>
                        </div>
                      );
                    })}
                  </section>
                )}
                <footer className="quick-reply"><CustomAvatar name={selected.accountEmail} address={selected.accountEmail} tone={accountTone(selected.accountEmail)} size="small" /><button onClick={openReply}>{t("mail.reader.replyTo", { sender: selected.from.name || selected.from.address })}</button></footer>
              </article>
              {state.attachmentPreview && <Suspense fallback={null}><AttachmentPreviewModal messageId={state.attachmentPreview.message.id} attachment={state.attachmentPreview.attachment} onClose={() => actions.closeAttachmentPreview()} /></Suspense>}
              </div>
            </ErrorBoundary>
          ) : (
            <div className="reader-empty"><div className="reader-orb"><Mail size={32} /></div><h2>{t("mail.reader.emptyTitle")}</h2><p>{t("mail.reader.emptyDescription")}</p></div>
          )}
</section>
        </div>
        {agentOpen && <Suspense fallback={<div className="agent-workspace-loading" role="status"><LoaderCircle className="spin" size={20} /><span>{t("agent.loading")}</span></div>}><AgentWorkspace accounts={accounts} messages={messages} currentMessage={selected ?? undefined} restoreFocusRef={agentLaunchButtonRef} demoMode={isDemo} providerSettingsRequestId={agentProviderSettingsRequestId} preloadedBootstrap={preloadedAgentBootstrap ?? undefined} agentAccessLevel={settings.agentAccessLevel} onAgentAccessLevelChange={(level) => { void updateSettings({ agentAccessLevel: level }); }} onClose={() => {
          closeAgentWorkspace();
          // Refresh agent bootstrap so the translation panel picks up any
          // provider configuration changes made inside the assistant workspace.
          if (!isDemo) {
            void api.agentBootstrap().then((value) => {
              const capped: AgentBootstrap = { ...value, conversations: value.conversations.slice(0, 50) };
              setPreloadedAgentBootstrap(capped);
            }).catch(() => undefined);
          }
        }} onOpenMessage={(messageId) => {
          closeAgentWorkspace();
          const message = messagesRef.current.find((item) => item.id === messageId);
          if (message) {
            void openMessage(message);
            return;
          }
          void api.message(messageId).then((fetched) => openMessage(fetched)).catch((error: unknown) => showToast(mailErrorToastMessage(error, t("mail.error.openNew"), t), "error"));
        }} /></Suspense>}
        <aside className="icon-rail" aria-label={t("navigation.management")}>
          <IconButton label={t("settings.title")} onClick={() => { actions.closeMobileSidebar(); actions.openSettings(); }}><Settings size={18} /></IconButton>
          <IconButton label={t("sending.title")} className={submissionAttentionCount ? "attention" : ""} onClick={() => { actions.closeMobileSidebar(); actions.openSendingStatus(); void refreshSubmissions(accounts, { silent: true }); }}><ListChecks size={18} />{submissionOutstandingCount > 0 && <span className="rail-badge" aria-hidden="true">{submissionOutstandingCount}</span>}</IconButton>
          <span className="icon-rail-divider" aria-hidden="true" />
          <IconButton label={t("calendar.title")} onClick={() => { actions.closeMobileSidebar(); actions.openCalendar(); if (!isDemo) calendarCache.warm(); }}><Calendar size={18} /></IconButton>
          <IconButton label={t("settings.contacts.title")} onClick={() => { actions.closeMobileSidebar(); actions.openContacts(); if (!isDemo) contactsCache.warm(); }}><Users size={18} /></IconButton>
          <IconButton label={t("settings.templates.title")} onClick={() => { actions.closeMobileSidebar(); actions.openTemplates(); if (!isDemo) templatesCache.warm(); }}><LayoutTemplate size={18} /></IconButton>
          <IconButton label={t("settings.account.title")} onClick={() => { actions.closeMobileSidebar(); actions.openAccounts(); }}><AtSign size={18} /></IconButton>
        </aside>
      </main>

      {state.addOpen && <Suspense fallback={null}><AccountConnectionModal providers={providers} existingAccounts={accounts} onClose={() => actions.closeAddAccount()} onAdded={handleAccountAdded} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} /></Suspense>}
      {state.composeOpen && <ComposeModal accounts={accounts} draft={state.composeDraft} onClose={() => actions.closeCompose()} onSent={(message, kind, undoDraft) => { if (undoDraft) showToast(message, kind, { label: t("compose.undo"), run: () => { window.setTimeout(() => { actions.openCompose(undoDraft); }, 0); } }); else showToast(message, kind); }} onDraftSaved={(accountId) => { if (!isDemo) void api.sync(accountId).then(() => load({ silent: true })).catch(() => undefined); }} onDraftDiscarded={(messageId) => { setMessages((items) => items.filter((message) => message.id !== messageId)); setSelectedId((current) => current === messageId ? null : current); }} onSubmissionChanged={() => void refreshSubmissions(accounts, { silent: true })} fallbackFocusRef={mobileMenuButtonRef} />}
      {state.settingsOpen && <Suspense fallback={null}><SettingsModal settings={settings} accounts={accounts} onClose={() => actions.closeSettings()} onSettingsChange={applySettings} onTestNotification={testDesktopNotification} onTestSound={testNotificationSound} onTranslationConfigurationChanged={refreshTranslationAvailability} onOpenAgentProviderSettings={() => { actions.closeSettings(); setAgentProviderSettingsRequestId((requestId) => requestId + 1); openAgentWorkspace(); }} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} /></Suspense>}
      {state.contactsOpen && <Suspense fallback={null}><ManagementDialogs demoMode={isDemo} onClose={() => actions.closeContacts()} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.templatesOpen && <Suspense fallback={null}><TemplatesDialog demoMode={isDemo} onClose={() => actions.closeTemplates()} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.calendarOpen && <Suspense fallback={null}><CalendarDialog demoMode={isDemo} onClose={() => actions.closeCalendar()} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.accountsOpen && <Suspense fallback={null}><AccountsDialog accounts={accounts} demoMode={isDemo} onClose={() => actions.closeAccounts()} onAccountRemoved={removeAccountFromView} onAccountSignatureChanged={updateAccountSignatureInState} onAccountSync={retryAccountSync} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.sendingStatusOpen && <Suspense fallback={null}><SendingStatusModal accounts={accounts} submissions={submissions} loading={submissionLoading} loadError={submissionLoadError} onClose={() => actions.closeSendingStatus()} onRefresh={() => refreshSubmissions(accounts)} onSyncAccount={async (accountId) => { await retryAccountSync(accountId); }} onCreateNewMessage={(draft) => { actions.closeSendingStatus(); actions.openCompose(draft); }} onCancelScheduled={cancelScheduledSubmission} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      <Suspense fallback={null}><TranslationTermsDialog open={state.translationTermsOpen} onAccept={acceptTranslationTerms} onDecline={declineTranslationTerms} /></Suspense>
      <Suspense fallback={null}><StartupUpdatePrompt
        snapshot={desktopUpdateStatus}
        onSnapshot={setDesktopUpdateStatus}
        defer={state.anyModalOrSidebar || syncing}
        onVisibilityChange={setUpdatePromptOpen}
      /></Suspense>
      {state.mobileSidebar && <button className="mobile-scrim" aria-label={t("navigation.closeMenu")} onClick={() => actions.closeMobileSidebar()} />}
      {toast && <div className={`toast ${toast.kind}`} role={toast.kind === "error" || toast.kind === "warning" ? "alert" : "status"} aria-atomic="true"><span className="toast-icon" aria-hidden="true">{toast.kind === "error" || toast.kind === "warning" ? <CircleAlert size={17} /> : toast.kind === "info" ? <Sparkles size={17} /> : <Check size={17} />}</span><span className="toast-message">{toast.message}</span>{toast.action && <button className="toast-action" type="button" onClick={() => { setToast(null); toast.action?.run(); }}>{toast.action.label}</button>}<button className="toast-dismiss" type="button" aria-label={t("common.closeNotification")} data-tooltip={t("common.closeNotification")} onClick={() => setToast(null)}><X size={16} /></button></div>}
      {autoReplyNotices.length > 0 && <AutoReplyToastStack behindModal={state.anyModalOpen} notices={autoReplyNotices} onDismiss={(notice) => setAutoReplyNotices((items) => items.filter((item) => autoReplyNoticeKey(item) !== autoReplyNoticeKey(notice)))} />}
      </div>
    </div>
  );
}
