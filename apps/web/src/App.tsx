import { lazy, Profiler, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import {
  Archive,
  ArrowDown,
  AtSign,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  FilePenLine,
  Focus,
  FolderTree,
  Inbox,
  Layers3,
  LayoutTemplate,
  ListChecks,
  ListFilter,
  LoaderCircle,
  Mail,
  MailOpen,
  Menu,
  Moon,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  Star,
  Sun, Users, Trash2, WifiOff, X,
} from "lucide-react";
import { AgentMark } from "./AgentMark";
import { CustomAvatar, SenderAvatar } from "./SenderAvatar";
import { WindowBar } from "./WindowBar";
import { api, type BatchJobSnapshot, type MoveTarget } from "./api";
import { calendarCache, contactsCache, templatesCache } from "./dialogPrefetch";
import DatePicker from "./DatePicker";
import { attachmentKinds, type AttachmentKind } from "./attachmentPresentation";
import { FolderNavigationIcon, IconButton } from "./mailUi";
import { useCalendarReminders } from "./calendar/useCalendarReminders";
import { useToastQueue } from "./notifications/useToastQueue";
import { desktopBridge, type DesktopAutoReplyNotice } from "./desktop";
import { useDesktopUpdateUi } from "./app/useDesktopUpdateUi";
import { demoDataSnapshot, ensureDemoLoaded } from "./demo-loader";
import { mailErrorToastMessage, presentMailError, type MailErrorPresentation } from "./errorPresentation";
import { AccountHealthBanner, accountShowsFreshness, accountStatusDotClass, useAccountHealth } from "./accountHealth";
import { useRealtimeSync, type SyncProgressPayload } from "./realtimeSync";
import { useCoalescedRefresh } from "./useCoalescedRefresh";
import { resolveScrollAnchor, type ScrollAnchorRow } from "./scrollAnchor";
import { buildForwardDraft, buildReplyDraft, isOwnSentMessage } from "./mailActions";
// ComposeModal loaded lazily below
import { sortMessages } from "./mailImportance";
import { collapseDuplicateMembers, groupMessagesByThread, mergeThreadMembers, mergeThreadSnapshot, shouldCollapseThread, sortThreadByTimeline, type ThreadSnapshot } from "./threads";
import {
  applyMessageMove,
  applyMessageMoveConfirmation,
  applyMessageSeenChange,
  applyPinnedUnseenCorrections,
  appendMessageCursorChain,
  canLoadMoreMessagePage,
  isArchivedMessage,
  matchesServerMessageQuery,
  mergePendingArchiveMoves,
  mergePendingLocalState,
  mergeUnreadViewSnapshot,
  nextMessageTotalForMove,
  nextMessageTotalForSnapshot,
  nextUnreadViewRecentlyReadIds,
  revertMessageMove,
  sidebarBadgeCounts,
  type MessageListQuery,
  type MessageListSortOrder,
  type MutablePendingLocalState,
  type PendingArchiveMove,
  createPendingLocalState,
  pinFlagOverride,
  unpinFlagOverride,
} from "./mailListState";
import { beginSpan, markInterval, recordCommit } from "./perfTelemetry";
import { providerDisplayName } from "./providerOnboarding";
import { playNotificationSound, primeNotificationSound } from "./sounds";
import { saveLocalePreference } from "./localePreference";
import { getAccountDisplayName, useAccountDisplayNames } from "./accountDisplayNameStore";
import { loadFolderDisplayMode, saveFolderDisplayMode, type FolderDisplayMode } from "./folderDisplayMode";
import { shouldShowLoading, type MailboxSelection } from "./folderNavigation";
import { createSettingsLoadCoordinator } from "./settingsLoadCoordinator";
import { defaultAppSettings, type Account, type AppSettings, type AppSettingsPatch, type Message, type OutboundAttachment, type ProviderInfo, type Stats } from "./types";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { usePopupExitTransition } from "./hooks/usePopupExitTransition";
import { dialogKeydownDecision, useDialogRouting } from "./dialogRouting";
import { useBatchSelection } from "./app/useBatchSelection";
import { useQuickMessageActions } from "./app/useQuickMessageActions";
import { useAttachmentExports } from "./app/useAttachmentExports";
import { useDesktopBridgeHandlers } from "./app/useDesktopBridgeHandlers";
import { resolveLocale, useI18n } from "./i18n";
import type { AgentBootstrap } from "./agentTypes";
import { AppDialogs } from "./AppDialogs";
import { MailReader } from "./MailReader";
import MessageList from "./MessageList";
import {
  formatMessageTime,
  formatFullDate,
  formatSyncFreshness,
  isCompactMailLayout,
  buildMessageQuery,
  demoMessageTotal,

  moveActionKey,
  demoMoveDestination,
  accountTone,
  currentSystemTheme,
  resolveTheme,
  backgroundUrl,
  collapseQuotedMailHtml,
  sanitizeMailHtml,
  splitQuotedMailText,
  textFromSanitizedMailHtml,
  replyBody,
  SWITCH_FADE_MS,
  MAIL_FADE_STAGGER_MS,
  AGENT_FADE_STAGGER_MS,
  localizeMessageLinks,
} from "./app/app-utils";
import { useMessageBody } from "./app/useMessageBody";
import { useMailTranslation } from "./app/useMailTranslation";
import { useSplashDismiss } from "./app/useSplashDismiss";
import { useOutboundSubmissions } from "./app/useOutboundSubmissions";
import { sortSubmissions } from "./sendingStatus";

const AgentWorkspace = lazy(() => import("./AgentWorkspace"));

type MailView = MessageListQuery["messageView"];

// Interface-switch ("fade hand-off") phases between the mail workspace and the
// Agent workspace. Each interface fades out/in in two layers — the mail
// sidebar and workspace leave first, then the Agent's conversation rail and
// main panel enter (and vice versa on close). These phases only drive class
// names; the motion itself lives in styles.css. `idle` is the settled state in
// either direction.
type AgentPhase = "idle" | "mail-leaving" | "agent-entering" | "agent-leaving" | "mail-entering";
const MAIL_SWITCH_TOTAL_MS = SWITCH_FADE_MS + MAIL_FADE_STAGGER_MS;
/** Sidebar spinner grace period: faster loads show no spinner at all. */
const SIDEBAR_LOADING_SPINNER_DELAY_MS = 250;
const AGENT_SWITCH_TOTAL_MS = SWITCH_FADE_MS + AGENT_FADE_STAGGER_MS;

const isDemo = new URLSearchParams(window.location.search).get("demo") === "1";
// Only the desktop smoke uses this: it runs the renderer in demo mode, which
// never reads the service's settings, so this is how it asks for a wallpaper
// preset to exercise that rendering path.
const demoBackgroundPreset = (() => {
  if (!isDemo) return undefined;
  const value = new URLSearchParams(window.location.search).get("background");
  return value === "paper" || value === "mist" || value === "coast" || value === "dawn" || value === "night"
    ? value
    : undefined;
})();
const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
const isDesktopSmoke = new URLSearchParams(window.location.search).get("desktopSmoke") === "1";
// The desktop smoke probes read settled computed styles from a hidden,
// render-throttled window: mark the root so styles.css can skip decorative
// reveal animations and the wallpaper probe observes its final opacity
// deterministically instead of racing the compositor.
if (isDesktopSmoke) document.documentElement.classList.add("desktop-smoke");
// The desktop shell injects its host platform ("win32" | "darwin" | "linux")
// so the window bar can pick the frameless layout (own controls vs. the
// macOS traffic-light slot).
const desktopPlatform = new URLSearchParams(window.location.search).get("platform") ?? undefined;


/**
 * Composes the reply body: the sender's signature, a blank line, then the
 * quoted original message. The empty leading block keeps the reply cursor at
 * the top while the signature and quote sit beneath it.
 */

export default function App() {
  useAccountDisplayNames();
  const { locale, locales, setLocale, t } = useI18n();
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(currentSystemTheme);
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...defaultAppSettings,
    locale,
    // Demo mode never loads persisted settings (loadSettings returns early), so
    // it ships the same plain surface a real install starts with — the presets
    // are a user choice, and a decorated sample frame misrepresents a new
    // install. The desktop smoke renders in demo mode and still has to keep the
    // wallpaper rendering path covered, so it requests a preset explicitly
    // through ?background=<preset> instead of relying on a demo default.
    ...(demoBackgroundPreset ? { backgroundPreset: demoBackgroundPreset } : {}),
  }));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingArchiveMoves, setPendingArchiveMoves] = useState<PendingArchiveMove[]>([]);
  const [pendingMoveVerifications, setPendingMoveVerifications] = useState<string[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  // Where the loaded window ends in the server's list order. null means the
  // list is exhausted — the server's own signal, not a comparison against a
  // total that grows with every arriving message.
  const [messageNextCursor, setMessageNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>({ accounts: 0, messages: 0, unread: 0 });
  const [unreadViewRecentlyReadIds, setUnreadViewRecentlyReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The shell's modal/panel routing and the global keydown decisions live in
  // useDialogRouting; the update prompt, reader-domain, and agent-workspace
  // routing stay here. The two modals App renders itself go in as arguments so
  // they land in the hook's MODAL_KEYS registry instead of beside it.
  const [agentOpen, setAgentOpen] = useState(false);
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false);
  const { state, actions, translationTermsPendingRef } = useDialogRouting({ batchDeleteOpen: pendingBatchDelete, agentOpen });
  const [view, setView] = useState<MailView>("inbox");
  const [selectedAccount, setSelectedAccount] = useState("all");
  // The bottom fade strip one-tap expands every account row (and hides the
  // folder list) so accounts that were folded or overflow the viewport can
  // still be reached; collapsing restores the previous mode.
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  // Sidebar folder presentation: "focused" keeps the classic single-account
  // folder list at the bottom; "tree" shows every account's folders inline
  // beneath its own row. A local UI preference, so it never round-trips
  // through server settings.
  const [folderDisplayMode, setFolderDisplayModeState] = useState<FolderDisplayMode>(loadFolderDisplayMode);
  // Per-account open/closed state for tree mode. Keyed by account id so
  // switching the selected account never collapses another account's list.
  const [expandedAccountIds, setExpandedAccountIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const setFolderDisplayMode = (mode: FolderDisplayMode) => {
    setFolderDisplayModeState(mode);
    saveFolderDisplayMode(mode);
  };
  const toggleAccountFolders = (accountId: string) => {
    setExpandedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };
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
    // Tree-mode folder toggles change the scroll content without resizing the
    // box, so the expansion count re-runs the overflow/fade measurement.
  }, [accounts.length, selectedAccount, accountsExpanded, expandedAccountIds.size, folderDisplayMode]);
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
  // Identity of the list DOM. Bumped in the SAME batch as a full row swap in
  // `load`, so the list viewport remounts exactly once per switch — at the
  // data change — instead of following the request lifecycle (which tore the
  // rows down and replayed the fade twice on stale data: the flicker on
  // view/account/folder/search switches). Silent refreshes merge in place and
  // never bump it.
  const [listSnapshotKey, setListSnapshotKey] = useState(0);
  // Sidebar spinner: appears only when a load actually takes a beat — below
  // the threshold a spinner would just flash in and out (the same flicker the
  // list skeleton had). Both entrance and exit transition in CSS.
  const [sidebarLoading, setSidebarLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSidebarLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSidebarLoading(true), SIDEBAR_LOADING_SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);
  const [syncing, setSyncing] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("idle");
  const [agentProviderListVersion, setAgentProviderListVersion] = useState(0);
  const [messageAction, setMessageAction] = useState<MoveTarget | null>(null);
  const [messageFlagging, setMessageFlagging] = useState(false);
  const [selectAllPaged, setSelectAllPaged] = useState(false);
  // The message the last shift+J/K expansion radiated from; plain J/K
  // navigation clears it so the next expansion starts from the opened row.
  const keyboardSelectionAnchorIdRef = useRef<string | null>(null);
  const [batchJob, setBatchJob] = useState<BatchJobSnapshot | null>(null);
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
  const [recipientDetailsOpen, setRecipientDetailsOpen] = useState(false);
  const [readerMoreOpen, setReaderMoreOpen] = useState(false);
  // The reader popovers animate their exit: user dismissals route through
  // beginClose (keep mounted with the closing class), parent-driven closes
  // (opening another view, selecting another message) stay instant.
  const { mounted: readerMoreMounted, closing: readerMoreClosing, beginClose: beginReaderMoreClose } = usePopupExitTransition(readerMoreOpen, () => setReaderMoreOpen(false));
  const { toast, showToast, dismissToast } = useToastQueue();
  const {
    submissions,
    submissionLoading,
    submissionLoadError,
    submissionAttentionCount,
    submissionOutstandingCount,
    refreshSubmissions,
    cancelScheduledSubmission,
    applyDemoSubmissions,
    reportLoadFailure: reportSubmissionsLoadFailure,
  } = useOutboundSubmissions({ isDemo, locale, t, showToast, accounts });
  const {
    desktopUpdateStatus,
    setDesktopUpdateStatus,
    runUpdateFooterAction,
    updateFooterAction,
    updateFooterBusy,
    updateBadgeDismissed,
    updateBadgeHidden,
    dismissUpdateBadge,
  } = useDesktopUpdateUi({ isDemo, t, showToast });
  const [autoReplyNotices, setAutoReplyNotices] = useState<DesktopAutoReplyNotice[]>([]);
  const [fatalError, setFatalError] = useState<MailErrorPresentation | null>(null);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [preloadedAgentBootstrap, setPreloadedAgentBootstrap] = useState<AgentBootstrap | null>(null);
  // The provider slice of the bootstrap, kept apart so the settings panel can publish
  // it when the splash preload never landed: patching the bootstrap in place was
  // dropped while it was null, pinning the AI-translation switch to startup state.
  const [agentProviderSnapshot, setAgentProviderSnapshot] = useState<Pick<AgentBootstrap, "providers" | "defaultProviderId"> | null>(null);
  const {
    dismissSplash,
    splashAnimationDoneRef,
    splashDataDoneRef,
    splashAgentDoneRef,
    splashDismissedRef,
  } = useSplashDismiss();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const agentLaunchButtonRef = useRef<HTMLButtonElement>(null);
  const readerTitleRef = useRef<HTMLHeadingElement>(null);
  const readerMoreRef = useRef<HTMLDivElement>(null);
  /** Anchors the compact sort/filter panel and closes it on outside clicks. */
  const listToolbarRef = useRef<HTMLDivElement>(null);
  /** Anchors the collapsible header search box so an outside click closes it. */
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const messageButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const messagesRef = useRef<Message[]>([]);
  // Latest accounts for callbacks that must not re-run when a refresh swaps the
  // array identity (the delivery-verification poll below restarts, and resets
  // its attempt budget, on every identity change otherwise).
  const accountsRef = useRef<Account[]>([]);
  accountsRef.current = accounts;
  const pendingArchiveMovesRef = useRef<PendingArchiveMove[]>([]);
  const unreadViewRecentlyReadIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Every optimistic local change a server snapshot must not overwrite: flag
  // edits from any path (row click, reader auto-read, batch selection, the
  // select-all-matching job) and rows the user already moved away. One registry
  // for all of them, consulted by every snapshot merge. The previous
  // per-feature sets left gaps between them: a delete issued while another
  // operation was reconciling came back on that operation's reload, because the
  // move was in no set at all.
  const pendingLocalStateRef = useRef<MutablePendingLocalState>(createPendingLocalState());
  /** Holds a moved row out of every snapshot until the server reports it at `destination`. */
  const pinMovedAway = useCallback((ids: Iterable<string>, destination: string): void => {
    if (!destination) return;
    for (const id of ids) pendingLocalStateRef.current.movedAway.set(id, destination);
  }, []);
  const unpinMovedAway = useCallback((ids: Iterable<string>): void => {
    for (const id of ids) pendingLocalStateRef.current.movedAway.delete(id);
  }, []);
  const viewRef = useRef<MailView>("inbox");
  const lastOpenedMessageIdRef = useRef<string | null>(null);
  const settingsLoadCoordinatorRef = useRef(createSettingsLoadCoordinator());
  const demoLoadedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  // Scroll anchor for background refreshes: which row the user is reading, and
  // how far into that row the viewport top sits. Applied after the merged list
  // lands (or dropped when nothing is pinned).
  const scrollAnchorRef = useRef<{ id: string; offset: number; topCaptured: number } | null>(null);
  // The smoke runner's OS theme preference is whatever the CI image happens
  // to have; force dark so probes observe one deterministic palette.
  const theme = isDesktopSmoke ? "dark" : resolveTheme(settings.theme, systemTheme);
  const activeBackgroundUrl = backgroundUrl(settings);
  // In light theme the pale canvas dilutes the picture; render the background
  // more densely there so presets stay visible. Dark theme is left untouched.
  const backgroundOpacity =
    activeBackgroundUrl && theme === "light"
      ? Math.min(1, (settings.backgroundIntensity * 1.22) / 100)
      : settings.backgroundIntensity / 100;
  // Identity of the list on screen. The list component keys its viewport on
  // `listSnapshotKey` (bumped with each settled row swap above) so a switch
  // remounts the viewport once, at the data change, and can fade the arriving
  // rows in instead of mutating one list in place.
  const pendingMoveVerificationKey = [...new Set([
    ...pendingMoveVerifications,
    ...pendingArchiveMoves.map((move) => move.id),
    ...messages.filter((message) => message.movePending === true).map((message) => message.id),
  ])].sort().join("|");
  const sidebarCounts = useMemo(() => sidebarBadgeCounts(stats), [stats]);
  useDialogFocus(state.mobileSidebar, sidebarRef);

  // Block-assembly switch between the mail workspace and the Agent workspace.
  // Opening: mail blocks leave in order, then the Agent workspace mounts and
  // its blocks enter. Closing mirrors it. A shared ref makes the sequence
  // re-entrant (rapid open/close cancels the previous timers) so the phase
  // always lands on `idle` with the workspace in the requested state.
  const agentSwitchTimersRef = useRef<number[]>([]);
  // Mirrors `agentPhase` for the open/close controllers so they can read the
  // current phase synchronously without being recreated on every phase change.
  const agentPhaseRef = useRef<AgentPhase>("idle");
  // Scroll position across the Agent round-trip: the mail column is
  // display:none while the workspace is open, which resets the virtualized
  // list's scroller. The offset is captured before hiding and re-applied once
  // the column is laid out again.
  const agentReturnScrollTopRef = useRef<number | null>(null);
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
    agentReturnScrollTopRef.current = messageListRef.current?.scrollTop ?? null;
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
      const savedTop = agentReturnScrollTopRef.current;
      agentReturnScrollTopRef.current = null;
      if (savedTop == null) return;
      // The scroller was display:none while the Agent workspace was open, so
      // its offset was lost. Restore once the column is laid out again (double
      // rAF: one frame for display, one for the virtualizer's re-measure) so
      // the user lands exactly where they left. A quick re-entry into the
      // workspace (phase back to "mail-leaving") cancels the restore.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (agentPhaseRef.current === "mail-leaving") return;
          const viewport = messageListRef.current;
          if (!viewport) return;
          viewport.scrollTop = savedTop;
        });
      });
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
      ".sending-status-list", ".sending-status-floating-tooltip", ".external-guide-code", ".connections-code-block",
      ".themed-select-menu", ".agent-message-content pre", ".agent-message-content table",
      ".agent-slash-menu", ".auto-reply-list",
      ".agent-memory-list", ".auto-reply-toast-reply",
      ".settings-account-signature textarea", ".template-editor textarea",
      ".calendar-field textarea",
    ].join(",");
    const BAND = 8; // matches the custom track width in styles.css
    let raf = 0;
    // Only the container under the pointer can need the class, so track it
    // with mouseover/mouseout and read exactly one rect per frame instead of
    // querying the whole document and measuring every scrollable on each move.
    let current: HTMLElement | null = null;
    const clear = () => {
      current?.classList.remove("scrollbar-reveal");
      current = null;
    };
    const over = (event: MouseEvent) => {
      const host = (event.target as HTMLElement | null)?.closest?.(REVEAL) as HTMLElement | null ?? null;
      if (host !== current) {
        clear();
        current = host;
      }
    };
    const out = (event: MouseEvent) => {
      if (!current) return;
      const next = (event.relatedTarget as HTMLElement | null)?.closest?.(REVEAL) as HTMLElement | null ?? null;
      if (next !== current) clear();
    };
    const onMove = (event: MouseEvent) => {
      if (!current || raf) return;
      const x = event.clientX;
      const y = event.clientY;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const host = current;
        if (!host) return;
        if (!host.isConnected) {
          clear();
          return;
        }
        const r = host.getBoundingClientRect();
        const onTrack =
          (x >= r.right - BAND && x <= r.right && y >= r.top && y <= r.bottom) ||
          (y >= r.bottom - BAND && y <= r.bottom && x >= r.left && x <= r.right);
        host.classList.toggle("scrollbar-reveal", onTrack);
      });
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
      clear();
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
  }, [actions]);

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
        if (!silent) {
          // Provide natural, subtle visual pacing for view/folder switches in demo mode
          await new Promise((resolve) => window.setTimeout(resolve, 140));
        }
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
          setMessageNextCursor(null);
          setStats(demo.demoStats);
        }
        setListSnapshotKey((value) => value + 1);
        setMessageTotal(demoTotal);
        // The demo dataset is handed to the list whole, so there is nothing left
        // to page: the chain starts already exhausted.
        setMessageNextCursor(null);
        applyDemoSubmissions(sortSubmissions(demo.createDemoSubmissions(locale)), true);
      } else {
        const messageQuery = buildMessageQuery({ accountId, folder, search, messageView, searchScope: scope, attachmentKind: attachmentKindFilter, after: dateBounds.after, before: dateBounds.before });
        const [nextAccounts, nextProviders, firstPage, nextStats] = await Promise.all([
          api.accounts(),
          api.providers(),
          api.messages(messageQuery),
          api.stats(),
        ]);
        if (requestId !== loadRequestRef.current) return;
        // The merge+setState section is the suspected renderer jank point on
        // large mailboxes: it rebuilds the whole row object tree and triggers a
        // full list commit. Network time is covered separately (slow-api).
        const finishMerge = beginSpan("list.merge");
        const pendingMerge = mergePendingArchiveMoves(
          firstPage.items,
          pendingArchiveMovesRef.current,
          nextAccounts,
          { accountId, folder, search, messageView, searchScope: scope },
        );
        const nextMessages = mergePendingLocalState(
          mergeUnreadViewSnapshot(
            pendingMerge.items,
            messagesRef.current,
            unreadViewRecentlyReadIdsRef.current,
            messageView === "unread",
          ),
          messagesRef.current,
          pendingLocalStateRef.current,
        );
        // The counts come from the same snapshot as the rows, so they need the
        // same correction: a badge read before the local commit landed would
        // otherwise flick back to the value the user just changed.
        const counts = applyPinnedUnseenCorrections(
          nextAccounts,
          nextStats,
          firstPage.items,
          nextMessages,
          pendingLocalStateRef.current,
        );
        setAccounts(counts.accounts);
        setProviders(nextProviders);
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
        // Same batch as the row swap: the viewport remounts here, and only
        // here, so the fade-in plays on the arriving rows.
        setListSnapshotKey((value) => value + 1);
        if (!silent) messageListRef.current?.scrollTo({ top: 0 });
        setMessageTotal(nextMessageTotalForSnapshot(firstPage.total, pendingMerge.items.length, messageView === "unread"));
        // A full load restarts the chain at the head, so the cursor that
        // continues the list is the one this page handed out.
        setMessageNextCursor(firstPage.nextCursor);
        setStats(counts.stats);
        setSelectedId((current) => {
          if (!current) return null;
          // A message opened from the conversation strip legitimately lives
          // outside the loaded list (another folder, or older than the list
          // window); the strip membership map witnesses it, so a background
          // refresh must not throw the reader back to the list.
          if (nextMessages.some((item) => item.id === current) || threadStripMembersRef.current.has(current)) return current;
          return null;
        });
        finishMerge({ rows: nextMessages.length, silent });
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
        reportSubmissionsLoadFailure(mailErrorToastMessage(error, t("sending.error.load"), t));
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        if (!splashDataDoneRef.current) {
          splashDataDoneRef.current = true;
          console.log("[nami-startup] renderer-data-loaded");
          if (splashAnimationDoneRef.current && splashAgentDoneRef.current && !splashDismissedRef.current) {
            splashDismissedRef.current = true;
            const el = document.getElementById("nami-splash");
            if (el) { el.classList.add("done"); setTimeout(() => el.remove(), 600); }
          }
        }
      }
    }
  }, [applyDemoSubmissions, locale, selectedAccount, selectedFolder, debouncedQuery, refreshSubmissions, reportSubmissionsLoadFailure, searchScope, splashAgentDoneRef, splashAnimationDoneRef, splashDataDoneRef, splashDismissedRef, t, view, attachmentKindFilter, dateBounds.after, dateBounds.before]);
  // A batch job's poll loop keeps the closure it started with for the whole run,
  // so its final reconciliation reload would otherwise use the account/folder
  // the job started in — yanking the user back there when the job ends. Reading
  // `load` through a ref keeps that reload pointed at the list on screen now.
  const loadRef = useRef(load);
  loadRef.current = load;

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
    // One viewport measurement for the whole pass: reading it inside the loop
    // forced a layout per row, and hundreds of rows can be mounted.
    const viewportTop = viewport.getBoundingClientRect().top;
    function* measurableRows(): Generator<ScrollAnchorRow> {
      for (const [id, node] of messageButtonRefs.current) {
        if (!node.isConnected) continue;
        const rect = node.getBoundingClientRect();
        yield { id, top: rect.top, height: rect.height };
      }
    }
    scrollAnchorRef.current = resolveScrollAnchor(measurableRows(), top, viewportTop);
  }, []);

  // The two list predicates the UI runs, each defined once. They differ on
  // purpose: the server query uses the debounced search (keystrokes must not
  // hammer the API) while local filtering uses the live query so typing feels
  // immediate. They used to be re-typed inline at a dozen call sites, where one
  // drifting field would silently break the optimistic inclusion checks.
  //
  // The input shape is derived from a consumer rather than hand-declared, so
  // these memos cannot drift from buildMessageQuery's signature.
  type ListQueryInput = Parameters<typeof buildMessageQuery>[0];
  const serverQuery = useMemo<ListQueryInput>(() => ({
    accountId: selectedAccount,
    folder: selectedFolder,
    search: debouncedQuery,
    messageView: view,
    searchScope,
    attachmentKind: attachmentKindFilter,
    after: dateBounds.after,
    before: dateBounds.before,
  }), [attachmentKindFilter, dateBounds, debouncedQuery, searchScope, selectedAccount, selectedFolder, view]);
  const filterQuery = useMemo<ListQueryInput>(() => ({ ...serverQuery, search: query }), [query, serverQuery]);

  const silentRefresh = useCallback(async () => {
    if (isDemo) return;
    // Interval telemetry: refreshes fire from SSE events, the desktop new-mail
    // bridge and the poll fallback — a gap far below/above the norm (a burst
    // or a stalled feed) is exactly the race territory around batch jobs.
    markInterval("list.silent-refresh");
    captureScrollAnchor();
    const requestId = ++loadRequestRef.current;
    try {
      const messageQuery = buildMessageQuery(serverQuery);
      const [nextAccounts, nextProviders, firstPage, nextStats] = await Promise.all([
        api.accounts(),
        api.providers(),
        api.messages(messageQuery),
        api.stats(),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const finishMerge = beginSpan("list.merge");
      const pendingMerge = mergePendingArchiveMoves(
        firstPage.items,
        pendingArchiveMovesRef.current,
        nextAccounts,
        serverQuery,
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
      // Reads, stars and moves that are still being confirmed by the server
      // must not be undone by a poll snapshot that raced the optimistic local
      // update (see pendingLocalStateRef).
      const withLocalPending = mergePendingLocalState(nextMessages, current, pendingLocalStateRef.current);
      const settled = view === "unread" || firstPage.total >= withLocalPending.length
        ? withLocalPending
        : withLocalPending.slice(0, Math.max(0, firstPage.total));
      const counts = applyPinnedUnseenCorrections(
        nextAccounts,
        nextStats,
        firstPage.items,
        settled,
        pendingLocalStateRef.current,
      );
      setAccounts(counts.accounts);
      setProviders(nextProviders);
      messagesRef.current = settled;
      setMessages(settled);
      setMessageTotal(nextMessageTotalForSnapshot(firstPage.total, Math.max(pendingMerge.items.length, settled.length), view === "unread"));
      setStats(counts.stats);
      // Same strip-membership witness as the load merge: silent polls must
      // keep off-list conversation members selected too.
      setSelectedId((value) => value && (settled.some((item) => item.id === value) || threadStripMembersRef.current.has(value)) ? value : null);
      finishMerge({ rows: settled.length, silent: true });
      // A silent poll just succeeded, so the network is back: clear any
      // fatal-error banner that a previous full load may have raised.
      setFatalError(null);
      await refreshSubmissions(nextAccounts, { silent: true });
    } catch {
      // Silent refresh must never disturb the current list; the next tick retries.
    }
  }, [captureScrollAnchor, refreshSubmissions, serverQuery, view]);

  // One gate for every refresh trigger (SSE events, the desktop new-mail IPC
  // bridge, the poll fallback and the Agent's mail-state changes). While the
  // window is hidden a request only marks the list dirty and is flushed by a
  // single catch-up on the next visibilitychange — so a background sync storm
  // stops feeding the main thread, and restoring the window never hits a burst
  // of queued full reloads. Foreground bursts collapse onto a trailing pass.
  const requestRefresh = useCoalescedRefresh(silentRefresh);

  // Live initial/full sync progress, fed by "sync.progress" SSE frames. It
  // drives a lightweight "syncing history" banner; the banner auto-dismisses a
  // short beat after the last frame so a busy multi-folder download stays
  // visible but a finished one does not linger.
  const [syncProgress, setSyncProgress] = useState<SyncProgressPayload | null>(null);
  const syncProgressClearTimerRef = useRef<number | null>(null);
  const handleSyncProgress = useCallback((next: SyncProgressPayload) => {
    if (syncProgressClearTimerRef.current !== null) {
      window.clearTimeout(syncProgressClearTimerRef.current);
      syncProgressClearTimerRef.current = null;
    }
    setSyncProgress(next);
    syncProgressClearTimerRef.current = window.setTimeout(() => setSyncProgress(null), 1_500);
  }, []);
  useEffect(() => () => {
    if (syncProgressClearTimerRef.current !== null) window.clearTimeout(syncProgressClearTimerRef.current);
  }, []);

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

  // Warm the lazily imported dialogs once the UI goes idle: their first real
  // open would otherwise fetch and parse the chunk mid-interaction, which
  // reads as a stutter (Agent workspace, settings, accounts, calendar).
  // requestIdleCallback without a timeout waits for a genuinely idle window,
  // so this never competes with the splash-period data load; the dynamic
  // imports resolve into the same module instances React.lazy uses.
  useEffect(() => {
  const warm = () => {
    void import("./AgentWorkspace");
    void import("./SettingsModal");
    void import("./AccountsDialog");
    void import("./CalendarDialog");
    void import("./ManagementDialogs");
    void import("./SendingStatusModal");
    void import("./AddAccountModal");
    void import("./AttachmentPreviewModal");
  };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(timer);
  }, []);

  const updateSettings = useCallback(async (patch: AppSettingsPatch) => {
    if (isDemo) {
      applySettings({ ...settings, ...patch, updatedAt: new Date().toISOString() });
      return;
    }
    applySettings(await api.updateSettings(patch));
  }, [applySettings, settings]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);

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
      setPreloadedAgentBootstrap(capped); setAgentProviderSnapshot(capped);
    }).catch(() => undefined).finally(() => {
      splashAgentDoneRef.current = true;
      console.log("[nami-startup] renderer-agent-bootstrap-done");
      dismissSplash();
    });
  }, [dismissSplash, splashAgentDoneRef]);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    return bridge.onSettingsChanged(() => void loadSettings());
  }, [loadSettings]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const { connectionState: realtimeConnectionState, reconnect: reconnectRealtime } = useRealtimeSync({
    enabled: !isDemo,
    pushEnabled: settings.realtimePushEnabled,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    isDesktop: Boolean(desktopBridge()),
    t,
    showToast,
    onRefresh: requestRefresh,
    onSettingsChanged: loadSettings,
    onSyncProgress: handleSyncProgress,
  });
  // Defensive: a read/unread toggle whose request hangs would otherwise leave
  // its id in the in-flight set, pinning the optimistic seen state on top of
  // every later poll. Dropping it on unmount means a fresh mount starts from
  // server truth.
  useEffect(() => {
    const pending = pendingLocalStateRef;
    return () => {
      pending.current.flagOverrides.clear();
      pending.current.movedAway.clear();
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
      const rawPlacement = host.getAttribute("data-tooltip-placement") as "top" | "bottom" | "left" | "right" | null;
      const nearTopBar = Boolean(host.closest(".window-bar, .agent-workspace-header, .column-header, .reader-toolbar"));
      const placement = rawPlacement || (nearTopBar ? "bottom" : "top");
      void computePosition(host, tooltip, {
        strategy: "fixed",
        placement,
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
      filterQuery,
      unreadViewRecentlyReadIds,
    ) && (!filterAttachments || message.hasAttachments));
    return sortMessages(base, sortOrder, {
      messages: base,
      accountEmails: new Set(accounts.map((account) => account.email.toLowerCase())),
      now: Date.now(),
    });
  }, [accounts, filterAttachments, filterQuery, messages, sortOrder, unreadViewRecentlyReadIds]);

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
    window.setTimeout(() => requestRefresh(), 8_000);
    window.setTimeout(() => requestRefresh(), 30_000);
  }, [load, requestRefresh]);

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
      ? demoMessageTotal(messages, demo.createDemoAccounts(locale), serverQuery)
      : 0;
  }, [locale, messageTotal, messages, serverQuery]);
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

  // Multi-select + bulk operations live in useBatchSelection. Predicate-wide
  // selection state (selectAllPaged/batchJob) and the delete-confirmation flag
  // stay up here because `load` and useDialogRouting precede this call.
  const {
    selectionMode,
    selectedMessageIds,
    batchBusy,
    batchDeleteConfirmClosing,
    requestBatchDeleteConfirmClose,
    resetBatchDeleteConfirmClosing,
    batchDeleteDialogRef,
    toggleSelectionMode,
    toggleMessageSelected,
    selectMessageRange,
    selectAllVisibleMessages,
    exitSelectionMode,
    applyBatchFlaggedChange,
    batchUpdateFlags,
    batchMoveMessages,
  } = useBatchSelection({
    isDemo,
    t,
    showToast,
    sortOrder,
    filteredMessages,
    messages,
    accounts,
    stats,
    loadedServerMessageCount,
    currentMessageTotal,
    searchScope,
    debouncedQuery,
    selectedAccount,
    selectedFolder,
    view,
    attachmentKindFilter,
    dateBounds,
    load,
    loadRef,
    loadRequestRef,
    messagesRef,
    pendingLocalStateRef,
    viewRef,
    selectAllPaged,
    setSelectAllPaged,
    setBatchJob,
    pendingBatchDelete,
    setPendingBatchDelete,
    pinMovedAway,
    unpinMovedAway,
    setMessages,
    setAccounts,
    setStats,
    setMessageTotal,
  });

  useEffect(() => {
    if (!selectedId || filteredMessages.some((message) => message.id === selectedId)) return;
    // A message opened from the conversation strip legitimately lives outside
    // the loaded list (another folder, a view that filters it out, or older
    // than the list window); the strip membership map witnesses it, so this
    // effect must not close the reader for it.
    if (threadStripMembersRef.current.has(selectedId)) return;
    setSelectedId(null);
    setRecipientDetailsOpen(false);
  }, [filteredMessages, selectedId]);

  const loadMore = async () => {
    // The end of the list is the server's word, not a count: a message
    // arriving while the user scrolls raises `currentMessageTotal` at the same
    // moment it is prepended above the loaded window, so `loaded >= total`
    // never became true and the old gate just kept paging past the end.
    if (loading || loadingMoreRef.current || !canLoadMoreMessagePage({ items: messages, nextCursor: messageNextCursor })) return;
    loadingMoreRef.current = true;
    const requestId = loadRequestRef.current;
    try {
      const nextQuery = buildMessageQuery({ ...serverQuery, cursor: messageNextCursor ?? undefined });
      const nextPage = await api.messages(nextQuery);
      if (requestId !== loadRequestRef.current) return;
      const pendingMerge = mergePendingArchiveMoves(
        nextPage.items,
        pendingArchiveMovesRef.current,
        accounts,
        serverQuery,
      );
      setMessages((items) => {
        // Paging is another place a server snapshot meets the local list, so it
        // has to respect the same pending overrides: without this, scrolling
        // could re-add a row the user just deleted or flip a row back to unread.
        // The chain then appends by id, so a row the local merge put back into
        // the window is not rendered twice.
        const merged = mergePendingLocalState(pendingMerge.items, items, pendingLocalStateRef.current);
        return appendMessageCursorChain(
          { items, nextCursor: messageNextCursor },
          { items: merged, nextCursor: nextPage.nextCursor },
        ).items;
      });
      setMessageNextCursor(nextPage.nextCursor);
      setMessageTotal(nextMessageTotalForSnapshot(nextPage.total, pendingMerge.items.length, viewRef.current === "unread"));
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
    // The re-arm is driven by the server's own "there is more" flag, so a list
    // that has run out stops being re-checked on every scroll event.
  }, [filteredMessages.length, loading, messageNextCursor]);

  // Gmail-style conversation: the server resolves the thread across all
  // mailboxes of the account, so members outside the loaded view (the user's
  // own replies in Sent, older replies that fell off the list window) can join
  // the strip. Refreshed when the open message changes and after a send.
  const [threadExtras, setThreadExtras] = useState<ThreadSnapshot | null>(null);
  // Last rendered strip membership. Clicking a chip resolves its target from
  // this map as a final fallback, so any member the strip ever showed opens
  // even when the list window and the extras snapshot have both moved on.
  const threadStripMembersRef = useRef<ReadonlyMap<string, Message>>(new Map());
  const [threadRefreshTick, setThreadRefreshTick] = useState(0);
  const selected = filteredMessages.find((message) => message.id === selectedId)
    ?? (isDemo
      ? null
      : threadExtras?.members.find((message) => message.id === selectedId)
        ?? (selectedId ? threadStripMembersRef.current.get(selectedId) : undefined)
        ?? null);
  // The list carries no body, so the open message is loaded on demand and
  // merged back into the row the reader resolves here.
  useMessageBody(isDemo, selected, setMessages, setThreadExtras);
  const threadExtrasForSelected = threadExtras && selected
    && (threadExtras.anchorId === selected.id || threadExtras.members.some((member) => member.id === selected.id))
    ? threadExtras.members
    : [];
  const selectedThread = selected
    ? collapseDuplicateMembers(sortThreadByTimeline(mergeThreadMembers(threadById.get(selected.id) ?? [], threadExtrasForSelected)), selected.id)
    : null;
  useEffect(() => {
    if (!selectedThread) return;
    const members = new Map<string, Message>();
    for (const member of selectedThread) members.set(member.id, member);
    threadStripMembersRef.current = members;
  }, [selectedThread]);
  // Thread membership is a whole-account scan on the server, so a burst of
  // selections (holding ↓ through a folder) coalesces into one request.
  const THREAD_REFRESH_DEBOUNCE_MS = 150;
  useEffect(() => {
    if (isDemo || !selectedId) {
      setThreadExtras(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => void api.messageThread(selectedId).then((response) => {
      // Merge instead of replace: a refetch must never drop a member the open
      // message still needs out from under the reader.
      if (!cancelled) setThreadExtras((current) => mergeThreadSnapshot(current, { anchorId: selectedId, members: response.items }));
    }).catch(() => undefined), THREAD_REFRESH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedId, threadRefreshTick]);
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
  const selectedMessageAccount = selected ? accounts.find((account) => account.id === selected.accountId) : undefined;
  // Sent-vs-received display: a message whose sender is one of the user's own
  // addresses is rendered recipient-first (Gmail style) — the reader header
  // shows who it went TO, and quick reply names the original recipient rather
  // than the user's own address. `to` can be empty (rare self-addressed
  // drafts), in which case every conditional below falls back to the
  // incoming-style rendering.
  const selectedIsOwnSent = selected ? isOwnSentMessage(selected, accounts.map((account) => account.email)) : false;
  const selectedSentRecipient = selectedIsOwnSent && selected ? selected.to[0] : undefined;
  const selectedReplyTargetAddress = selected && selectedIsOwnSent
    ? buildReplyDraft(selected, [...accounts.map((account) => account.email), selected.accountEmail]).to[0]
    : undefined;
  const selectedReplyTarget = selected && selectedReplyTargetAddress
    ? selected.to.find((recipient) => recipient.address.trim().toLowerCase() === selectedReplyTargetAddress.trim().toLowerCase())
    : undefined;
  const quickReplySender = selected
    ? selectedReplyTarget
      ? (selectedReplyTarget.name || selectedReplyTarget.address)
      : selectedReplyTargetAddress ?? (selected.from.name || selected.from.address)
    : "";
  const visibleAttachments = selected?.attachments.filter((attachment) => !attachment.related) ?? [];
  const selectedAccountRecord = accounts.find((account) => account.id === selectedAccount);
  const localizedProviderName = (account: Pick<Account, "provider" | "providerName">) => providerDisplayName({ id: account.provider, name: account.providerName }, locale, t);
  const sentFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Sent");
  const draftsFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Drafts");
  // Sidebar drafts/sent statistics: the active account's folder totals when
  // one account is selected, otherwise the sum across every account carrying
  // such a folder ("all accounts" view).
  const draftsCount = useMemo(() => (selectedAccountRecord ? [selectedAccountRecord] : accounts)
    .reduce((sum, account) => sum + (account.folders.find((folder) => folder.specialUse === "\\Drafts")?.total ?? 0), 0), [accounts, selectedAccountRecord]);
  const sentCount = useMemo(() => (selectedAccountRecord ? [selectedAccountRecord] : accounts)
    .reduce((sum, account) => sum + (account.folders.find((folder) => folder.specialUse === "\\Sent")?.total ?? 0), 0), [accounts, selectedAccountRecord]);
  // Drafts/sent navigation from the "all accounts" view: a unified folder view
  // works when every carrying account shares one folder path (the messages
  // query filters cross-account by path); mixed paths fall back to the first
  // carrying account so the click always lands somewhere predictable.
  const folderNavTarget = useCallback((specialUse: string, selectedPath: string | undefined): { accountId: string; path: string } | undefined => {
    if (selectedAccountRecord) return selectedPath ? { accountId: selectedAccountRecord.id, path: selectedPath } : undefined;
    const carrying = accounts
      .flatMap((account) => account.folders.filter((folder) => folder.specialUse === specialUse).map((folder) => ({ accountId: account.id, path: folder.path })));
    if (carrying.length === 0) return undefined;
    const paths = new Set(carrying.map((entry) => entry.path));
    if (paths.size === 1) return { accountId: "all", path: carrying[0].path };
    return carrying[0];
  }, [accounts, selectedAccountRecord]);
  const draftsNavTarget = folderNavTarget("\\Drafts", draftsFolder?.path);
  const sentNavTarget = folderNavTarget("\\Sent", sentFolder?.path);
  const draftsNavActive = draftsNavTarget !== undefined && selectedFolder === draftsNavTarget.path && (draftsNavTarget.accountId === "all" ? selectedAccount === "all" : selectedAccount === draftsNavTarget.accountId);
  const sentNavActive = sentNavTarget !== undefined && selectedFolder === sentNavTarget.path && (sentNavTarget.accountId === "all" ? selectedAccount === "all" : selectedAccount === sentNavTarget.accountId);
  // Plain declaration (hoisted): the click handlers run long after this
  // component scope has finished evaluating, so referencing the later-defined
  // chooseFolder here is safe.
  function openFolderNavTarget(target: { accountId: string; path: string }) {
    if (target.accountId !== "all" && target.accountId !== selectedAccount) {
      clearUnreadViewRecentlyRead();
      setSelectedAccount(target.accountId);
      setAccountsExpanded(false);
      setSelectedId(null);
      setRecipientDetailsOpen(false);
    }
    chooseFolder(target.path);
  }
  const selectedFolderRecord = selectedAccountRecord?.folders.find((folder) => folder.path === selectedFolder);
  // Folder display name shared by the column header and the empty state:
  // single-account view uses the account's own record; the unified ("all
  // accounts") view falls back to the first carrying account's folder name so
  // localized names survive there too; the raw path (last segment) is the
  // final fallback for a folder that just vanished from the account tree.
  const selectedFolderName = selectedFolderRecord?.name
    ?? accounts.flatMap((account) => account.folders).find((folder) => folder.path === selectedFolder)?.name
    ?? (selectedFolder ? selectedFolder.split("/").pop() || selectedFolder : "");
const emptyMessageList = useMemo(() => (query.trim()
    ? { title: t("mail.empty.searchTitle"), description: t("mail.empty.searchDescription"), canClearSearch: true }
    : view === "unread"
      ? { title: t("mail.empty.unreadTitle"), description: t("mail.empty.unreadDescription"), canClearSearch: false }
    : view === "starred"
      ? { title: t("mail.empty.starredTitle"), description: t("mail.empty.starredDescription"), canClearSearch: false }
    : view === "archived"
      ? { title: t("mail.empty.archiveTitle"), description: t("mail.empty.archiveDescription"), canClearSearch: false }
    : view === "snoozed"
      ? { title: t("mail.empty.snoozedTitle"), description: t("mail.empty.snoozedDescription"), canClearSearch: false }
    : view === "attachments"
      ? { title: t("mail.empty.attachmentsTitle"), description: t("mail.empty.attachmentsDescription"), canClearSearch: false }
    : selectedFolder
      ? { title: t("mail.empty.folderTitle", { folder: selectedFolderName || selectedFolder }), description: t("mail.empty.folderDescription"), canClearSearch: false }
      : { title: t("mail.empty.inboxTitle"), description: t("mail.empty.inboxDescription"), canClearSearch: false }), [query, selectedFolderName, selectedFolder, t, view]);
  const { issues: accountIssues, accountsNeedingAttention, primaryAccountNeedingAttention, primaryAccountIssue, healthAlert, dismissHealthAlert } = useAccountHealth(accounts, t);
  const safeHtml = useMemo(
    () => selected?.htmlBody ? sanitizeMailHtml(selected.htmlBody, theme === "dark") : "",
    [selected?.htmlBody, theme],
  );
  // Reply quotes collapse to a one-line toggle (Gmail-style). The fold lives
  // at render time: sanitization, the translation pipeline and reply quoting
  // all keep working on the original body, and re-opening a message starts
  // with the quotes hidden again.
  const [quotedExpanded, setQuotedExpanded] = useState(false);
  useEffect(() => {
    setQuotedExpanded(false);
  }, [selected?.id]);
  const {
    translationState,
    shouldRenderTranslationPanel,
    llmTranslationAvailable,
    translationMailStyle,
    verificationCodes,
    translationAvailability,
    setForceShowTranslationId,
    refreshTranslationAvailability,
    translateSelectedMessage,
    translateSelectedMessageWithLlm,
    showSelectedTranslation,
    hideSelectedTranslation,
    cancelTranslation,
    acceptTranslationTerms,
    declineTranslationTerms,
    copyDetectedVerificationCode,
  } = useMailTranslation({
    selected,
    safeHtml,
    locale,
    t,
    theme,
    isDemo,
    showToast,
    agentProviderSnapshot,
    translationTermsAccepted: state.translationTermsAccepted,
    translationTermsPendingRef,
    setTranslationTermsOpen: actions.setTranslationTermsOpen,
    setTranslationTermsAccepted: actions.setTranslationTermsAccepted,
  });
  const readerHtml = useMemo(() => {
    if (!safeHtml) return "";
    const translatedHtml = translationState.phase === "ready" && translationState.visible ? translationState.translatedHtml : null;
    const body = translatedHtml ?? safeHtml;
    return quotedExpanded ? body : collapseQuotedMailHtml(body, t("mail.reader.showQuoted"));
  }, [safeHtml, translationState, quotedExpanded, t]);
  const readerTextSource = selected?.textBody || (selected?.snippet ? localizeMessageLinks(selected.snippet, locale) : "") || "";
  const readerTextParts = useMemo(
    () => quotedExpanded ? { body: readerTextSource, quote: "" } : splitQuotedMailText(readerTextSource),
    [readerTextSource, quotedExpanded],
  );
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
    // The preview pane is rendered inside the reader, so it may only describe
    // the message currently open there — never reuse a previous one's preview.
    actions.pruneAttachmentPreviewFor(message.id);
    const account = accounts.find((item) => item.id === message.accountId);
    const isDraft = account?.folders.some((folder) => folder.path === message.mailbox && folder.specialUse === "\\Drafts");
    if (isDraft) {
      setSelectedId(null);
      setRecipientDetailsOpen(false);
      // A list row only carries a text preview, and the composer must open on
      // the whole draft — editing a truncated body would silently drop the
      // rest of what the user wrote.
      const draft = !isDemo && message.htmlBody === undefined
        ? await api.message(message.id).catch(() => message)
        : message;
      let attachments: OutboundAttachment[] = [];
      if (!isDemo) {
        try {
          attachments = (await api.draftOutboundAttachments(draft.id)).items;
          if (!attachments.length && draft.attachments.some((attachment) => !attachment.related)) {
            attachments = (await api.importDraftOutboundAttachments(draft.id)).items;
          }
        } catch (error) {
          showToast(mailErrorToastMessage(error, t("mail.error.readDraftAttachments"), t), "error");
        }
      }
      actions.openCompose({
        accountId: draft.accountId,
        to: draft.to.map((recipient) => recipient.address).filter(Boolean).join(", "),
        cc: draft.cc.map((recipient) => recipient.address).filter(Boolean).join(", "),
        subject: draft.subject,
        text: draft.textBody || draft.snippet,
        inReplyTo: draft.inReplyTo ?? undefined,
        references: draft.references,
        sourceDraftId: draft.id,
        attachments,
      });
      return;
    }
    lastOpenedMessageIdRef.current = message.id;
    setSelectedId(message.id);
    setRecipientDetailsOpen(false);
    setReaderMoreOpen(false);
    if (!message.seen && !pendingLocalStateRef.current.flagOverrides.has(message.id)) {
      pinFlagOverride(pendingLocalStateRef.current, message.id);
      updateUnreadViewRecentlyRead(message, true);
      applyLocalSeenChange(message, true);
      // A message opened from the conversation strip may only exist in the
      // server-resolved thread extras (outside the loaded view); keep its
      // read state in sync there too, or the strip's unread dot would stick.
      const patchThreadExtrasSeen = (seen: boolean) => setThreadExtras((current) => current
        ? { ...current, members: current.members.map((member) => member.id === message.id ? { ...member, seen } : member) }
        : current);
      patchThreadExtrasSeen(true);
      if (isDemo) {
        unpinFlagOverride(pendingLocalStateRef.current, message.id);
        patchThreadExtrasSeen(true);
      } else {
        void api.markSeen(message.id, true).catch((error: unknown) => {
          const readMessage = { ...message, seen: true, flags: [...new Set([...message.flags, "\\Seen"])] };
          updateUnreadViewRecentlyRead(readMessage, false);
          applyLocalSeenChange(readMessage, false);
          patchThreadExtrasSeen(false);
          showToast(t("mail.error.markRead", { message: mailErrorToastMessage(error, t("mail.error.markReadFallback"), t) }), "error");
        }).finally(() => {
          unpinFlagOverride(pendingLocalStateRef.current, message.id);
        });
      }
    }
  }, [accounts, actions, applyLocalSeenChange, showToast, t, updateUnreadViewRecentlyRead]);
  // Stable identity for the agent transcript's "open referenced message" handler:
  // it reaches memoised AgentMessageRow, where a per-render arrow re-parses every historic message.
  const openMessageRef = useRef(openMessage);
  openMessageRef.current = openMessage;
  const handleAgentOpenMessage = useCallback((messageId: string) => {
    closeAgentWorkspace();
    const known = messagesRef.current.find((item) => item.id === messageId);
    if (known) { void openMessageRef.current(known); return; }
    void api.message(messageId).then((fetched) => openMessageRef.current(fetched)).catch((error: unknown) => showToast(mailErrorToastMessage(error, t("mail.error.openNew"), t), "error"));
  }, [closeAgentWorkspace, showToast, t]);

  const closeReader = useCallback((restoreFocus = false) => {
    const messageId = lastOpenedMessageIdRef.current;
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    setReaderMoreOpen(false);
    // The preview pane unmounts with the reader, so its state must not
    // outlive it — same path the drawer takes from its own onClose.
    actions.closeAttachmentPreview();
    if (!restoreFocus || !messageId) return;
    window.requestAnimationFrame(() => messageButtonRefs.current.get(messageId)?.focus());
  }, [actions]);

  // Eleven routes close the reader without closeReader (archive, star, view
  // and account switch, the draft branch, …); one effect covers them all.
  useEffect(() => {
    if (selectedId === null) actions.closeAttachmentPreview();
  }, [selectedId, actions]);

  const accountEmails = useMemo(() => accounts.map((account) => account.email), [accounts]);
  // One conversation-strip entry. Own sent mail renders recipient-first
  // (Gmail style): the recipient's avatar plus a "To <name>" line instead of
  // presenting the user as the sender. Falls back to the sender when the
  // message carries no recipients.
  const renderThreadStripItem = (threadMessage: Message) => {
    const ownSent = isOwnSentMessage(threadMessage, accountEmails);
    const hasRecipient = ownSent && threadMessage.to[0] !== undefined;
    const person = hasRecipient ? threadMessage.to[0]! : threadMessage.from;
    const personLabel = person.name || person.address || t("mail.thread.unknownPerson");
    return (
      <button key={threadMessage.id} type="button" className={`thread-strip-item ${threadMessage.id === selected?.id ? "active" : ""}`} data-tooltip={hasRecipient ? t("mail.thread.sentTooltip", { recipient: personLabel, time: formatFullDate(threadMessage.sentAt, locale) }) : t("mail.thread.receivedTooltip", { person: personLabel, time: formatFullDate(threadMessage.sentAt, locale) })} onClick={() => void openMessage(threadMessage)}>
        <SenderAvatar name={person.name} address={person.address} tone={accountTone(person.address)} size="small" gravatarEnabled={settings.avatarGravatarEnabled} bimiEnabled={settings.avatarBimiEnabled} />
        <span className="thread-strip-copy"><strong>{hasRecipient ? t("mail.reader.toRecipient", { recipient: personLabel }) : personLabel}</strong><time>{formatMessageTime(threadMessage.sentAt, locale)}</time></span>
        {!threadMessage.seen && <span className="unread-dot" aria-hidden="true" />}
      </button>
    );
  };

  useEffect(() => {
    if (!selectedId || !isCompactMailLayout()) return;
    const frame = window.requestAnimationFrame(() => readerTitleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  useEffect(() => {
    if (!readerMoreOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (readerMoreRef.current?.contains(event.target as Node)) return;
      beginReaderMoreClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") beginReaderMoreClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [readerMoreOpen, beginReaderMoreClose]);

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
  }, [accounts, actions, locale, safeHtml, selected, t]);

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
  }, [accounts, actions, locale, safeHtml, selected, t]);

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
  }, [accounts, actions, safeHtml, selected]);

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
      const currentQuery: MessageListQuery = serverQuery;
      const destination = demoMoveDestination(accounts, selected.accountId, target);
      // Hold the row out of every snapshot for the whole round-trip. Another
      // operation finishing triggers a reload, and a server snapshot taken
      // before this move commits still lists the row in its source mailbox —
      // re-adding it is the "the deleted mail came back" bug.
      pinMovedAway([selected.id], destination);
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
      unpinMovedAway([selected.id]);
      setMessageAction(null);
    }
  };

  const clearSearch = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    searchInputRef.current?.focus();
  }, []);

  // Perf telemetry: the list is the largest commit surface in the app; a slow
  // commit here (bulk flag flips, a big silent refresh) is the jank the user
  // feels. recordCommit thresholds decide what gets recorded.
  const onMessageListRender = useCallback((id: string, phase: string, actualDuration: number) => {
    recordCommit(id, actualDuration, phase);
  }, []);

  const toggleSelectedStar = async () => {
    if (!selected || selectedRemoteActionsBlocked) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextFlagged = !selected.flagged;
    setMessageFlagging(true);
    // Optimistic and pinned like every other flag edit: the star shows at once,
    // and a refresh racing the round-trip cannot restore the old flags. This
    // path previously did neither, so a star could flip back and leave
    // messagesRef behind the rendered state.
    pinFlagOverride(pendingLocalStateRef.current, selected.id);
    applyBatchFlaggedChange([selected.id], nextFlagged);
    try {
      if (!isDemo) await api.updateMessageFlags(selected.id, { flagged: nextFlagged });
      if (view === "starred" && !nextFlagged) setSelectedId(null);
      showToast(nextFlagged ? t("mail.action.starred") : t("mail.action.unstarred"));
    } catch (error) {
      applyBatchFlaggedChange([selected.id], selected.flagged);
      showToast(mailErrorToastMessage(error, t("mail.error.updateStar"), t), "error");
    } finally {
      unpinFlagOverride(pendingLocalStateRef.current, selected.id);
      setMessageFlagging(false);
    }
  };

  const toggleSelectedSeen = async () => {
    if (!selected || selectedRemoteActionsBlocked || pendingLocalStateRef.current.flagOverrides.has(selected.id)) return;
    const nextSeen = !selected.seen;
    pinFlagOverride(pendingLocalStateRef.current, selected.id);
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
      unpinFlagOverride(pendingLocalStateRef.current, selected.id);
      setMessageFlagging(false);
    }
  };

  // Quick row/reader actions (star/seen/move) and the snooze popup live in
  // useQuickMessageActions; the shared busy flags (messageFlagging and
  // messageAction) stay up here because the reader-domain actions above also
  // flip them.
  const {
    snoozeOpen,
    setSnoozeOpen,
    snoozeMounted,
    snoozeClosing,
    beginSnoozeClose,
    snoozeRef,
    snoozeCustomUntil,
    setSnoozeCustomUntil,
    snoozeOptions,
    selectedIsSnoozed,
    setSelectedSnoozed,
    clearSelectedSnooze,
    quickToggleStar,
    quickToggleSeen,
    quickMoveMessage,
  } = useQuickMessageActions({
    selected,
    selectedRemoteActionsBlocked,
    isDemo,
    t,
    showToast,
    accounts,
    messages,
    stats,
    filteredMessages,
    filterQuery,
    viewRef,
    messageFlagging,
    messageAction,
    setMessageFlagging,
    setMessageAction,
    batchBusy,
    applyBatchFlaggedChange,
    pendingLocalStateRef,
    messagesRef,
    loadRequestRef,
    load,
    pinMovedAway,
    unpinMovedAway,
    setMessages,
    setAccounts,
    setStats,
    setMessageTotal,
    applyLocalSeenChange,
    updateUnreadViewRecentlyRead,
    setSelectedId,
  });

  // Attachment/exports surface (single download, zip-all, EML/print/VCF/ICS,
  // preview) lives in useAttachmentExports; the calendar import dialog it can
  // open is rendered by the dialog block below.
  const {
    attachmentDownloads,
    zipAllPhase,
    calendarImportPayload,
    setCalendarImportPayload,
    downloadAttachment,
    zipAllAttachments,
    exportSelectedEml,
    printSelectedMessage,
    exportContactVcf,
    exportCalendarIcs,
    openCalendarImport,
    handleIcsAttachmentImport,
    openAttachmentPreview,
  } = useAttachmentExports({
    selected,
    selectedMovePending,
    selectedMoveLocationUnverified,
    isDemo,
    t,
    showToast,
    visibleAttachments,
    pendingArchiveMovesRef,
    openAttachmentPreviewRoute: actions.openAttachmentPreview,
  });

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
    if (bridge?.testNativeNotification) {
      // The settings test must exercise the SAME pipeline as a real new-mail
      // alert: the main process plays the configured custom sound (soft/bright)
      // and pairs the notification silence with the actual playback outcome.
      // The old renderer-side assumption (prime the AudioContext, mute the
      // banner, and play from the renderer) left the test banner SILENT —
      // nobody played anything when the real sound had moved to the main
      // process — which is exactly the "notification without sound" report.
      const result = await bridge.testNativeNotification({
        title: "Nami Mail",
        body: t("settings.notifications.testBody"),
        // The main process decides the silence from the actual playback
        // outcome; the payload value is never taken at face value.
        silent: false,
      });
      if (!result.shown) throw new Error(t("settings.error.systemNotificationsUnavailable"));
      return;
    }
    const payload = {
      title: "Nami Mail",
      body: t("settings.notifications.testBody"),
      silent: testSettings.notificationSound === "none",
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
    // In the browser there is no main-process player: prime the AudioContext
    // from this user gesture and play the tone alongside the banner. A failed
    // prime falls back to the audible default instead of a silent banner.
    const customSound = testSettings.notificationSound !== "none" && testSettings.notificationSound !== "system";
    if (customSound) {
      const primed = await primeNotificationSound();
      if (primed && playNotificationSound(testSettings.notificationSound)) {
        new Notification(payload.title, { ...payload, silent: true });
        return;
      }
    }
    new Notification(payload.title, payload);
  }, [t]);

  const testNotificationSound = useCallback(async (sound: AppSettings["notificationSound"]) => {
    if (sound === "none") return;
    const primed = await primeNotificationSound();
    if (primed && playNotificationSound(sound)) return;
    if (sound === "system") {
      await testDesktopNotification({ ...settings, notificationSound: sound });
    }
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

  /**
   * Enter the loading phase for a sidebar navigation — but only when the target
   * is a genuinely different list. One effect keyed on `load` drives the reload
   * and only `load`'s finally clears the flag, so a click that does not move
   * the selection raises one nothing can lower. See folderNavigation.ts. */
  const beginNavigation = useCallback((next: MailboxSelection) => {
    if (shouldShowLoading({ accountId: selectedAccount, folder: selectedFolder, view }, next)) setLoading(true);
  }, [selectedAccount, selectedFolder, view]);

  const chooseView = useCallback((next: MailView) => {
    viewRef.current = next;
    clearUnreadViewRecentlyRead();
    beginNavigation({ accountId: selectedAccount, folder: "", view: next });
    setView(next);
    setSelectedFolder("");
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    actions.closeMobileSidebar();
  }, [actions, beginNavigation, clearUnreadViewRecentlyRead, selectedAccount]);

  // Desktop-bridge subscriptions (new-mail toasts, notification clicks,
  // compose/inbox deep links, auto-reply events) plus the mailto-document
  // handler and the web-runtime auto-reply poll live in
  // useDesktopBridgeHandlers; autoReplyNotices stays here because the toast
  // stack below renders it.
  useDesktopBridgeHandlers({
    isDemo,
    t,
    showToast,
    requestRefresh,
    openNotifiedMessage,
    chooseView,
    openCompose: actions.openCompose,
    setAutoReplyNotices,
  });

  // Demo copy is seeded per locale; a language switch re-seeds accounts and
  // submissions so folder names, signatures and subjects follow the UI.
  useEffect(() => {
    if (!isDemo || !demoLoadedRef.current) return;
    void (async () => {
      const demo = await ensureDemoLoaded();
      setAccounts(demo.createDemoAccounts(locale));
      setMessages(demo.demoMessages);
      setStats(demo.demoStats);
      applyDemoSubmissions(sortSubmissions(demo.createDemoSubmissions(locale)));
    })();
  }, [applyDemoSubmissions, locale]);

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
          subject: demo.demoTranslate(locale, "demo.autoReply.subject", "季度数据回顾与本周同步"),
          fromName: "Lena Chen",
          fromAddress: "lena.chen@example.com",
          sensitive: false,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 20 * 60 * 1000).toISOString(),
          replyPreview: demo.demoTranslate(locale, "demo.autoReply.replyPreview", "收到，我会在本周内完成数据回顾并同步给你。谢谢！"),
        },
      ]);
    })();
  }, [locale]);

  useCalendarReminders({
    demoMode: isDemo,
    locale,
    onOpenCalendar: actions.openCalendar,
    showToast,
    notificationsEnabled: settings.notificationsEnabled,
  });

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
        translationTermsOpen: state.translationTermsOpen,
        attachmentPreviewOpen: state.attachmentPreview !== null,
        batchDeleteOpen: state.batchDeleteOpen,
        agentOpen: state.agentOpen,
        selectedId,
        selected: Boolean(selected),
        keyboardSelectionAnchorId: keyboardSelectionAnchorIdRef.current,
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
        // Drives the same state as the preview's own onClose path (the X
        // button / requestClose tail both end in closeAttachmentPreview →
        // setAttachmentPreview(null)). Normally AttachmentPreviewModal's
        // capture listener handles Escape first; this case is the shell
        // fallback (e.g. while the lazy modal is still mounting).
        case "close_attachment_preview": actions.closeAttachmentPreview(); return;
        case "close_reader": closeReader(true); return;
        case "focus_search": searchInputRef.current?.focus(); return;
        case "compose": actions.openCompose(); return;
        case "add_account": actions.openAddAccount(); return;
        case "reply": openReply(); return;
        case "reply_all": openReplyAll(); return;
        case "forward": openForward(); return;
        case "open_message": keyboardSelectionAnchorIdRef.current = null; void openMessage(decision.action.message); return;
        case "select_range":
          keyboardSelectionAnchorIdRef.current = decision.action.ids.at(-1) ?? null;
          selectMessageRange(decision.action.ids);
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accounts.length, actions, state.addOpen, state.calendarOpen, closeReader, state.composeOpen, filteredMessages, state.mobileSidebar, openForward, openMessage, openReply, openReplyAll, selectMessageRange, selected, selectedId, state.contactsOpen, state.templatesOpen, state.accountsOpen, state.sendingStatusOpen, state.translationTermsOpen, state.attachmentPreview, state.settingsOpen, state.agentOpen, state.batchDeleteOpen, updatePromptOpen]);

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
    beginNavigation({ accountId: selectedAccount, folder: path, view: "inbox" });
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
            {/* Loading indicator: the spinner and the count share ONE fixed
                18px end slot on the ACTIVE entry — the count fades out while
                the spinner fades in, so the two can never overlap, the label
                is never squeezed into a re-ellipsis, and the column width
                never jumps. Below the 250ms grace nothing changes. */}
            {(() => {
              const loadingEnd = sidebarLoading;
              return (
                <>
                  <button aria-pressed={view === "inbox" && !selectedFolder} className={view === "inbox" && !selectedFolder ? "active" : ""} onClick={() => chooseView("inbox")}><Inbox size={18} /><span>{t("mail.unifiedInbox")}</span><span className={`sidebar-end${loadingEnd && view === "inbox" && !selectedFolder ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className="sidebar-count" data-tooltip={t("mail.inboxCountTooltip")}>{sidebarCounts.inbox || ""}</em></span></button>
                  <button aria-pressed={view === "unread"} className={view === "unread" ? "active" : ""} onClick={() => chooseView("unread")}><Mail size={18} /><span>{t("mail.unread")}</span><span className={`sidebar-end${loadingEnd && view === "unread" ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className="sidebar-count" data-tooltip={t("mail.unreadCountTooltip")}>{sidebarCounts.unread || ""}</em></span></button>
                  <button aria-pressed={view === "starred"} className={view === "starred" ? "active" : ""} onClick={() => chooseView("starred")}><Star size={18} /><span>{t("mail.starred")}</span><span className={`sidebar-end${loadingEnd && view === "starred" ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className="sidebar-count">{sidebarCounts.starred || ""}</em></span></button>
                  <button aria-pressed={view === "archived"} className={view === "archived" ? "active" : ""} onClick={() => chooseView("archived")}><Archive size={18} /><span>{t("mail.action.archive")}</span><span className={`sidebar-end${loadingEnd && view === "archived" ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span></span></button>
                  <button aria-pressed={view === "snoozed"} className={view === "snoozed" ? "active" : ""} onClick={() => chooseView("snoozed")}><Clock size={18} /><span>{t("mail.snoozed")}</span><span className={`sidebar-end${loadingEnd && view === "snoozed" ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className="sidebar-count">{sidebarCounts.snoozed || ""}</em></span></button>
                  <button aria-pressed={view === "attachments"} className={view === "attachments" ? "active" : ""} onClick={() => chooseView("attachments")}><Paperclip size={18} /><span>{t("mail.attachments")}</span><span className={`sidebar-end${loadingEnd && view === "attachments" ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className="sidebar-count">{sidebarCounts.attachments || ""}</em></span></button>
                  <button className={draftsNavActive ? "active" : ""} disabled={!draftsNavTarget} onClick={() => draftsNavTarget && openFolderNavTarget(draftsNavTarget)}><FilePenLine size={18} /><span>{t("mail.drafts")}</span><span className={`sidebar-end${loadingEnd && draftsNavActive ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em>{draftsCount || ""}</em></span></button>
                  <button className={sentNavActive ? "active" : ""} disabled={!sentNavTarget} onClick={() => sentNavTarget && openFolderNavTarget(sentNavTarget)}><Send size={18} /><span>{t("mail.sent")}</span><span className={`sidebar-end${loadingEnd && sentNavActive ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em>{sentCount || ""}</em></span></button>
                </>
              );
            })()}
          </nav>

          <div className="accounts-heading"><span>{t("mail.accounts")}</span><span className="accounts-heading-actions"><IconButton label={folderDisplayMode === "tree" ? t("mail.folderMode.switchToFocused") : t("mail.folderMode.switchToTree")} onClick={() => setFolderDisplayMode(folderDisplayMode === "tree" ? "focused" : "tree")}><span className="folder-mode-icon" data-mode={folderDisplayMode} aria-hidden="true"><FolderTree size={16} className="folder-mode-tree" /><Focus size={16} className="folder-mode-focused" /></span></IconButton><IconButton label={t("account.add")} onClick={() => { actions.closeMobileSidebar(); actions.openAddAccount(); }}><Plus size={16} /></IconButton></span></div>
          <div className="account-list" data-folder-mode={folderDisplayMode} ref={accountListRef}>
            <button aria-pressed={selectedAccount === "all"} className={selectedAccount === "all" ? "active" : ""} onClick={() => { clearUnreadViewRecentlyRead(); beginNavigation({ accountId: "all", folder: "", view }); setSelectedAccount("all"); setAccountsExpanded(false); setSelectedFolder(""); setSelectedId(null); setRecipientDetailsOpen(false); actions.closeMobileSidebar(); }}><span className="account-avatar all"><Layers3 size={14} /></span><span className="account-copy"><strong>{t("mail.allAccounts")}</strong><small>{t("mail.accountCount", { count: accounts.length })}</small></span></button>
            {accounts.map((account) => {
              const issue = accountIssues.get(account.id);
              const providerName = localizedProviderName(account);
              const freshness = formatSyncFreshness(account.lastSyncedAt, t);
              const displayName = getAccountDisplayName(account.email);
              // With a single account selected, the other account rows fold
              // away so the folder list gets the room; "all accounts" stays.
              // Expanded mode shows every row again for one-tap switching.
              // Tree mode never folds rows: every account stays visible with
              // its own folders right beneath it.
              const collapsed = folderDisplayMode === "focused" && !accountsExpanded && selectedAccount !== "all" && selectedAccount !== account.id;
              const foldersOpen = folderDisplayMode === "tree" && expandedAccountIds.has(account.id) && account.folders.length > 0;
              const selectAccount = () => {
                clearUnreadViewRecentlyRead();
                beginNavigation({ accountId: account.id, folder: "", view });
                setSelectedAccount(account.id);
                setAccountsExpanded(false);
                setSelectedFolder("");
                setSelectedId(null);
                setRecipientDetailsOpen(false);
                actions.closeMobileSidebar();
                // Selecting a *different* account in tree mode opens its
                // folders as well; an already-selected row only resets to
                // its inbox so a folded list stays folded. The disclosure
                // chevron is the only way to fold them.
                if (folderDisplayMode === "tree" && account.folders.length > 0 && selectedAccount !== account.id) {
                  setExpandedAccountIds((current) => new Set(current).add(account.id));
                }
              };
              const rowLabel = displayName ? `${displayName} (${account.email})` : account.email;
              const rowInner = (
                <>
                  <CustomAvatar name={displayName || account.email} address={account.email} tone={accountTone(account.email)} className="account-avatar" />
                  <span className="account-copy"><strong>{displayName || account.email.split("@")[0]}</strong><small>{accountShowsFreshness(issue) ? t("mail.accountFreshness", { provider: providerName, freshness }) : issue!.title}</small></span>
                  <span className={`status-dot ${accountStatusDotClass(issue, account.status)}`} aria-hidden="true" />
                </>
              );
              // One DOM shape serves both modes: focused mode folds the other
              // rows and closes every inline list (both transitioned), while
              // tree mode keeps rows unfolded and opens each list on its own.
              return (
                <div key={account.id} className="account-tree-item">
                  <div className={`account-tree-row${collapsed ? " hidden" : ""}`}>
                    <button title={account.email} aria-label={rowLabel} aria-pressed={selectedAccount === account.id} aria-hidden={collapsed || undefined} tabIndex={collapsed ? -1 : undefined} className={`account-tree-main${selectedAccount === account.id ? " active" : ""}`} onClick={selectAccount}>{rowInner}</button>
                    {account.folders.length > 0 && (
                      <button type="button" className={`account-tree-toggle${foldersOpen ? " open" : ""}`} aria-expanded={foldersOpen} aria-hidden={folderDisplayMode === "focused" || undefined} tabIndex={folderDisplayMode === "focused" || collapsed ? -1 : undefined} aria-label={foldersOpen ? t("mail.folderMode.collapseFolders") : t("mail.folderMode.expandFolders")} onClick={() => toggleAccountFolders(account.id)}>
                        <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                  {account.folders.length > 0 && (
                    <div className={`account-tree-folders${foldersOpen ? " open" : ""}`} aria-hidden={!foldersOpen || undefined}>
                      <div className="account-tree-folders-clip">
                        <div className="account-tree-folders-list">
                          {account.folders.map((folder) => {
                            const folderActive = selectedAccount === account.id && selectedFolder === folder.path;
                            return (
                              <button key={folder.path} className={folderActive ? "active" : ""} aria-pressed={folderActive} onClick={() => openFolderNavTarget({ accountId: account.id, path: folder.path })}><FolderNavigationIcon specialUse={folder.specialUse} name={folder.name} /><span>{folder.name}</span><span className={`sidebar-end${sidebarLoading && folderActive ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className={folder.unseen ? "folder-unseen" : ""}>{folder.unseen || folder.total || ""}</em></span></button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {folderDisplayMode === "focused" && !accountsExpanded && selectedAccount === "all" && accountListOverflow && !accountListAtBottom && <div className="account-list-fade" aria-hidden="true" />}
          </div>

          {folderDisplayMode === "focused" && (accountsExpanded || selectedAccount !== "all" || accountListOverflow) && (
            <button type="button" className={`account-list-more${accountsExpanded ? " expanded" : ""}`} aria-expanded={accountsExpanded} aria-label={accountsExpanded ? t("mail.collapseAccounts") : t("mail.expandAccounts")} onClick={() => setAccountsExpanded(!accountsExpanded)}>
              <ChevronDown size={16} />
              {accountsExpanded && <span>{t("mail.collapseAccounts")}</span>}
            </button>
          )}

          <div className={`folder-list${folderDisplayMode === "focused" && !accountsExpanded && selectedAccountRecord && selectedAccountRecord.folders.length > 0 ? " show" : ""}`} ref={folderListRef} style={folderListMaxHeight != null ? ({ "--folder-list-max": `${folderListMaxHeight}px` } as CSSProperties) : undefined} aria-hidden={folderDisplayMode === "tree" || accountsExpanded || !(selectedAccountRecord && selectedAccountRecord.folders.length > 0)}>
                {folderDisplayMode === "focused" && selectedAccountRecord && selectedAccountRecord.folders.length > 0 && (
                  <>
                    <span className="folder-title">{t("mail.folders")}</span>
                    {selectedAccountRecord.folders.map((folder) => (
                      <button key={folder.path} className={selectedFolder === folder.path ? "active" : ""} aria-pressed={selectedFolder === folder.path} onClick={() => chooseFolder(folder.path)}><FolderNavigationIcon specialUse={folder.specialUse} name={folder.name} /><span>{folder.name}</span><span className={`sidebar-end${sidebarLoading && selectedFolder === folder.path ? " loading" : ""}`}><span className="sidebar-spinner" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span><em className={folder.unseen ? "folder-unseen" : ""}>{folder.unseen || folder.total || ""}</em></span></button>
                    ))}
                  </>
                )}
          </div>

          <div className="sidebar-footer">
            {desktopUpdateStatus && desktopUpdateStatus.phase === "available" && desktopUpdateStatus.suppression === "none" && !updateBadgeHidden && desktopUpdateStatus.targetVersion && (
              <div className="sidebar-footer-update-row">
                <div className={`update-badge${updateBadgeDismissed ? " dismissed" : ""}`}>
                  <span className="update-badge-icon" aria-hidden="true"><ArrowDown size={14} /></span>
                  <span className="update-badge-pop">
                    <span className="update-badge-text">{t("update.badge.available", { version: desktopUpdateStatus.targetVersion })}</span>
                    <button type="button" className="update-badge-download" disabled={updateFooterBusy} onClick={() => void runUpdateFooterAction({ kind: "download" })}>{t("update.badge.download")}</button>
                    <button type="button" className="update-badge-close" aria-label={t("update.badge.dismiss")} onClick={dismissUpdateBadge}><X size={12} /></button>
                  </span>
                </div>
              </div>
            )}
            {updateFooterAction && (
              <div className="sidebar-footer-update-row">
                <button type="button" className={`update-footer-button update-footer-button--${desktopUpdateStatus?.reason === "storageInsufficient" ? "storage" : updateFooterAction.kind}`} title={desktopUpdateStatus?.reason === "storageInsufficient" ? t("update.status.storageInsufficient") : undefined} disabled={updateFooterBusy || updateFooterAction.kind === "downloading"} onClick={() => void runUpdateFooterAction(updateFooterAction)}>
                  {updateFooterAction.kind === "downloading" ? <><LoaderCircle className="spin" size={13} aria-hidden="true" />{t("update.footer.downloading", { percent: updateFooterAction.percent })}</> : updateFooterAction.kind === "install" ? <><RotateCcw size={13} aria-hidden="true" />{t("update.footer.ready")}</> : desktopUpdateStatus?.reason === "storageInsufficient" ? <><CircleAlert size={13} aria-hidden="true" />{t("update.footer.storageInsufficient")}</> : <><CircleAlert size={13} aria-hidden="true" />{t("update.footer.retry")}</>}
                </button>
              </div>
            )}
            <div className="sidebar-footer-info">
              <div className="sidebar-footer-privacy"><ShieldCheck size={14} /><span><strong>{t("app.dataStaysLocal")}</strong><small>{t("app.credentialsLocal")}</small></span></div>
              <span className="version">v{__NAMI_APP_VERSION__}</span>
            </div>
          </div>
        </aside>

        <div className="mail-workspace">
        <section className="message-column">
          <header className="column-header">
            <IconButton label={t("navigation.openMenu")} className="mobile-only" buttonRef={mobileMenuButtonRef} onClick={() => actions.openMobileSidebar()}><Menu size={19} /></IconButton>
            <div><span className="eyebrow">{selectedAccount === "all" ? t("mail.unifiedMailbox") : selectedAccountRecord ? localizedProviderName(selectedAccountRecord).toUpperCase() : ""}</span><h1>{query.trim() ? t("mail.search.resultsTitle", { query: query.trim() }) : view === "unread" ? t("mail.unread") : view === "starred" ? t("mail.starred") : view === "archived" ? t("mail.action.archive") : view === "snoozed" ? t("mail.snoozed") : view === "attachments" ? t("mail.attachments") : selectedFolderName || t("mail.inbox")}</h1></div>
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

          {realtimeConnectionState === "offline" && (
            <div className="realtime-offline-banner" role="status" aria-live="polite">
              <WifiOff size={14} />
              <span>
                <strong>{t("mail.realtime.offlineTitle")}</strong>
                <small>{t("mail.realtime.offlineDetail", { seconds: settings.refreshIntervalSeconds })}</small>
              </span>
              <button type="button" onClick={reconnectRealtime}>{t("mail.realtime.retry")}</button>
            </div>
          )}

          {syncProgress && syncProgress.totalEstimate > 0 && (
            <div className="sync-progress-banner" role="status" aria-live="polite">
              {t("mail.syncingHistory", { processed: syncProgress.processed, totalCount: syncProgress.totalEstimate })}
            </div>
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
                <IconButton
                  label={t("mail.action.moveToTrash")}
                  className="selection-action selection-action-danger"
                  onClick={() => {
                    resetBatchDeleteConfirmClosing();
                    setPendingBatchDelete(true);
                  }}
                  disabled={!selectedMessageIds.size && !selectAllPaged}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <button className="selection-done" type="button" onClick={exitSelectionMode} disabled={batchBusy}>{t("mail.selection.done")}</button>
            </div>
          </div>

          <Profiler id="MessageList" onRender={onMessageListRender}>
            <MessageList
              loading={loading}
              listKey={listSnapshotKey}
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
              avatarBimiEnabled={settings.avatarBimiEnabled}
              emptyMessageList={emptyMessageList}
              messageListRef={messageListRef}
              messageButtonRefs={messageButtonRefs}
              onReconnect={load}
              onAddAccount={actions.openAddAccount}
              onClearSearch={clearSearch}
              onOpenMessage={openMessage}
              onToggleSelected={toggleMessageSelected}
              onSelectRange={selectMessageRange}
              onQuickToggleStar={quickToggleStar}
              onQuickToggleSeen={quickToggleSeen}
              onQuickMoveMessage={quickMoveMessage}
            />
          </Profiler>
        </section>

        <MailReader
          state={state}
          actions={actions}
          t={t}
          locale={locale}
          locales={locales}
          isDemo={isDemo}
          settings={settings}
          selected={selected}
          selectedThread={selectedThread}
          selectedMessageAccount={selectedMessageAccount}
          selectedSentRecipient={selectedSentRecipient}
          quickReplySender={quickReplySender}
          selectedMovePending={selectedMovePending}
          selectedMoveLocationUnverified={selectedMoveLocationUnverified}
          selectedRemoteActionsBlocked={selectedRemoteActionsBlocked}
          selectedIsArchived={selectedIsArchived}
          selectedIsInJunk={selectedIsInJunk}
          selectedIsSnoozed={selectedIsSnoozed}
          selectedMoveActionLabel={selectedMoveActionLabel}
          localizedProviderName={localizedProviderName}
          closeReader={closeReader}
          openReply={openReply}
          openReplyAll={openReplyAll}
          openForward={openForward}
          toggleSelectedSeen={toggleSelectedSeen}
          toggleSelectedStar={toggleSelectedStar}
          moveSelectedMessage={moveSelectedMessage}
          openAgentWorkspace={openAgentWorkspace}
          openCalendarImport={openCalendarImport}
          exportSelectedEml={exportSelectedEml}
          printSelectedMessage={printSelectedMessage}
          exportContactVcf={exportContactVcf}
          exportCalendarIcs={exportCalendarIcs}
          snoozeOpen={snoozeOpen}
          setSnoozeOpen={setSnoozeOpen}
          snoozeMounted={snoozeMounted}
          snoozeClosing={snoozeClosing}
          beginSnoozeClose={beginSnoozeClose}
          snoozeRef={snoozeRef}
          snoozeCustomUntil={snoozeCustomUntil}
          setSnoozeCustomUntil={setSnoozeCustomUntil}
          snoozeOptions={snoozeOptions}
          setSelectedSnoozed={setSelectedSnoozed}
          clearSelectedSnooze={clearSelectedSnooze}
          readerMoreOpen={readerMoreOpen}
          setReaderMoreOpen={setReaderMoreOpen}
          readerMoreMounted={readerMoreMounted}
          readerMoreClosing={readerMoreClosing}
          beginReaderMoreClose={beginReaderMoreClose}
          readerMoreRef={readerMoreRef}
          recipientDetailsOpen={recipientDetailsOpen}
          setRecipientDetailsOpen={setRecipientDetailsOpen}
          readerTitleRef={readerTitleRef}
          threadCollapsed={threadCollapsed}
          threadCollapsible={threadCollapsible}
          setThreadCollapsedPref={setThreadCollapsedPref}
          renderThreadStripItem={renderThreadStripItem}
          verificationCodes={verificationCodes}
          copyDetectedVerificationCode={copyDetectedVerificationCode}
          shouldRenderTranslationPanel={shouldRenderTranslationPanel}
          translationAvailability={translationAvailability}
          translationState={translationState}
          llmTranslationAvailable={llmTranslationAvailable}
          translationMailStyle={translationMailStyle}
          refreshTranslationAvailability={refreshTranslationAvailability}
          translateSelectedMessage={translateSelectedMessage}
          translateSelectedMessageWithLlm={translateSelectedMessageWithLlm}
          showSelectedTranslation={showSelectedTranslation}
          hideSelectedTranslation={hideSelectedTranslation}
          cancelTranslation={cancelTranslation}
          setForceShowTranslationId={setForceShowTranslationId}
          readerHtml={readerHtml}
          readerTextParts={readerTextParts}
          readerTextSource={readerTextSource}
          setQuotedExpanded={setQuotedExpanded}
          visibleAttachments={visibleAttachments}
          attachmentDownloads={attachmentDownloads}
          zipAllPhase={zipAllPhase}
          zipAllAttachments={zipAllAttachments}
          downloadAttachment={downloadAttachment}
          handleIcsAttachmentImport={handleIcsAttachmentImport}
          openAttachmentPreview={openAttachmentPreview}
        />
        </div>
        {agentOpen && <Suspense fallback={<div className="agent-workspace-loading" role="status"><LoaderCircle className="spin" size={20} /><span>{t("agent.loading")}</span></div>}><AgentWorkspace accounts={accounts} messages={messages} currentMessage={selected ?? undefined} restoreFocusRef={agentLaunchButtonRef} demoMode={isDemo} overlayOpen={state.settingsOpen} providerListVersion={agentProviderListVersion} onOpenModelSettings={() => actions.openSettingsTo("models")} preloadedBootstrap={preloadedAgentBootstrap ?? undefined} agentAccessLevel={settings.agentAccessLevel} onAgentAccessLevelChange={(level) => { void updateSettings({ agentAccessLevel: level }); }} onMailStateChanged={() => { requestRefresh(); }} onClose={() => {
          closeAgentWorkspace();
          // Refresh so the translation panel picks up provider changes made in the workspace.
          if (!isDemo) void api.agentBootstrap().then((value) => { const capped: AgentBootstrap = { ...value, conversations: value.conversations.slice(0, 50) }; setPreloadedAgentBootstrap(capped); setAgentProviderSnapshot(capped); }).catch(() => undefined);
        }} onOpenMessage={handleAgentOpenMessage} /></Suspense>}
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

      <AppDialogs
        state={state}
        actions={actions}
        t={t}
        isDemo={isDemo}
        syncing={syncing}
        agentOpen={agentOpen}
        accounts={accounts}
        providers={providers}
        settings={settings}
        mobileMenuButtonRef={mobileMenuButtonRef}
        toast={toast}
        showToast={showToast}
        dismissToast={dismissToast}
        handleAccountAdded={handleAccountAdded}
        load={load}
        setThreadRefreshTick={setThreadRefreshTick}
        setMessages={setMessages}
        setSelectedId={setSelectedId}
        applySettings={applySettings}
        testDesktopNotification={testDesktopNotification}
        testNotificationSound={testNotificationSound}
        refreshTranslationAvailability={refreshTranslationAvailability}
        acceptTranslationTerms={acceptTranslationTerms}
        declineTranslationTerms={declineTranslationTerms}
        agentProviderSnapshot={agentProviderSnapshot}
        preloadedAgentBootstrap={preloadedAgentBootstrap}
        setAgentProviderSnapshot={setAgentProviderSnapshot}
        setPreloadedAgentBootstrap={setPreloadedAgentBootstrap}
        setAgentProviderListVersion={setAgentProviderListVersion}
        calendarImportPayload={calendarImportPayload}
        setCalendarImportPayload={setCalendarImportPayload}
        submissions={submissions}
        submissionLoading={submissionLoading}
        submissionLoadError={submissionLoadError}
        refreshSubmissions={refreshSubmissions}
        cancelScheduledSubmission={cancelScheduledSubmission}
        removeAccountFromView={removeAccountFromView}
        updateAccountSignatureInState={updateAccountSignatureInState}
        retryAccountSync={retryAccountSync}
        desktopUpdateStatus={desktopUpdateStatus}
        setDesktopUpdateStatus={setDesktopUpdateStatus}
        setUpdatePromptOpen={setUpdatePromptOpen}
        autoReplyNotices={autoReplyNotices}
        setAutoReplyNotices={setAutoReplyNotices}
        pendingBatchDelete={pendingBatchDelete}
        batchDeleteConfirmClosing={batchDeleteConfirmClosing}
        batchBusy={batchBusy}
        requestBatchDeleteConfirmClose={requestBatchDeleteConfirmClose}
        batchDeleteDialogRef={batchDeleteDialogRef}
        selectAllPaged={selectAllPaged}
        currentMessageTotal={currentMessageTotal}
        selectedMessageIds={selectedMessageIds}
        setPendingBatchDelete={setPendingBatchDelete}
        batchMoveMessages={batchMoveMessages}
      />
      </div>
    </div>
  );
}
