import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  Bot,
  CalendarDays,
  Check,
  CircleAlert,
  ClipboardList,
  Copy,
  Eye,
  FileDown,
  FileText,
  FolderSearch,
  LoaderCircle,
  Mail,
  MessageCircle,
  MessageCirclePlus,
  PanelLeftClose,
  Pencil,
  Plus,
  Quote,
  Reply,
  Search,
  SquareCheck,
  SquareSlash,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Server,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  UsersRound,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { api } from "./api";
import { AttachmentFileIcon } from "./mailUi";
import { presentAttachment } from "./attachmentPresentation";
import { type AgentSlashCommand, type AgentSlashSubcommand } from "@nami/agent-contracts";
import { buildSlashMenu, slashCompletionText, slashKeepsMenuOpen, slashMenuActiveIndex } from "./slashMenu";
import { mentionActiveIndex, mentionQuery } from "./mentionMenu";
import { AgentMark } from "./AgentMark";
import { AgentMarkdown, streamingMarkdownContent } from "./AgentMarkdown";
import { desktopBridge } from "./desktop";
import type {
  AgentBootstrap,
  AgentCitation,
  AgentConfirmation,
  AgentConversation,
  AgentMessage,
  AgentProviderList,
  AgentProviderSummary,
  AgentStreamEvent,
  AgentToolActivity,
} from "./agentTypes";
import { agentScopeFor, sameAgentScope, scopeTargetForConversation, type AgentScopeTarget } from "./agentContext";
import { isSupportedFile, processFile, type ProcessedFile } from "./fileProcessor";
import type { Account, AgentAccessLevel, Message } from "./types";
import { useI18n, type Translate } from "./i18n";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { AgentProviderSettings, type AgentSettingsPane, configuredProviderId } from "./agent/AgentProviderSettings";
import { AgentMessageRow } from "./agent/AgentMessageRow";
import { AgentToolList } from "./agent/AgentToolCard";
import { AgentConfirmationCard } from "./agent/AgentConfirmationCard";
import { AgentRecallButton, AgentScrubberBar, AgentMessageContent, RevokeNotice } from "./agent/AgentSmallComponents";
import { AgentPickerPopover } from "./agent/AgentPickerPopover";
import {
  type AgentMode,
  SCRUBBER_BAR_GAP,
  SCRUBBER_PREVIEW_DELAY_MS,
  scrubberBarBlur,
  newLocalId,
  currentTime,
  CONVERSATION_PROVIDERS_KEY,
  shortDate,
  REVOKE_NOTICE_SECONDS,
  type MailReference,
  type MentionItem,
  MAX_MAIL_REFERENCES,
  MENTION_QUERY_DEBOUNCE_MS,
  MENTION_PAGE_SIZE,
  mailReferenceFor,
  mentionItemFor,
  revokeFailureMessage,
  readRevokedIds,
  writeRevokedIds,
  LAST_ACTIVE_CONVERSATION_KEY,
  readLastActiveConversationId,
  lastMessageIsUnanswered,
  lastMessageIsStreaming,
  applyRevokedMarks,
  purgeStaleErrors,
  sourceLabel,
  copyToClipboard,
  dedupeCitations,
  truncateForPreview,
  truncateForContext,
  messageWithEvent,
  interruptAssistantMessage,
  applyConfirmationDecision,
  expireConfirmation,
} from "./agent/agent-utils";
import { useMountedVisible } from "./hooks/useMountedVisible";
import { createDemoConversation } from "./agent/agent-demo-data";
import { useAgentSession } from "./agent/useAgentSession";

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
  /** Notified when an agent tool mutates primary mail state (flags, moves) so
   *  the mail list can refresh instead of lagging behind the conversation. */
  onMailStateChanged?: () => void;
};


/**
 * Shared upward accordion panel used by the composer permission and model
 * pickers. Wraps the options in the animated popover surface and provides
 * roving-tabindex keyboard navigation (Arrow/Home/End), focusing the checked
 * option when it opens so the menu is immediately keyboard-ready. Options are
 * native buttons, so Enter/Space activate them without extra wiring.
 */

export default function AgentWorkspace({ accounts, currentMessage, onClose, onOpenMessage, restoreFocusRef, demoMode = false, providerSettingsRequestId = 0, preloadedBootstrap, agentAccessLevel = "send-confirmed", onAgentAccessLevelChange, onMailStateChanged }: AgentWorkspaceProps) {
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
  /**
   * Mails the user explicitly introduced as context (via /@ or by entering
   * from a message); each one renders as a chip above the composer and rides
   * along as a reference on the next send. Cap 8, deduped by message id.
   */
  const [mailReferences, setMailReferences] = useState<MailReference[]>(() =>
    currentMessage ? [mailReferenceFor(currentMessage)] : [],
  );
  /** Set when the user dismisses the /@ menu (Esc) or introduces a mail. */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  /** Keyboard selection inside the /@ menu. */
  const [mentionIndex, setMentionIndex] = useState(0);
  /** The /@ menu's current result rows. */
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  /** Whether the user was told the 8-reference cap is reached. */
  const [mentionLimitReached, setMentionLimitReached] = useState(false);
  /** The composer text mirrored so async pagination reads the latest search term. */
  const mentionTermRef = useRef<string | null>(null);
  const mentionLoadingRef = useRef(false);
  const mentionPageRef = useRef(1);
  /** Memory summaries the agent suggested saving; each needs a save or dismiss. */
  const [pendingMemorySuggestions, setPendingMemorySuggestions] = useState<string[]>([]);
  const [mode, setMode] = useState<AgentMode>("agent");
  const [providerId, setProviderId] = useState("");
  // The header scope picker's selection: the account the agent searches (a
  // concrete account, or "all"). Entering from a mail message defaults to that
  // message's account; otherwise the first connected account is used.
  const [scopeTarget, setScopeTarget] = useState<AgentScopeTarget>(currentMessage?.accountId ?? accounts[0]?.id ?? "all");
  /**
   * Snapshot of the entry context. Entering from a mail message pins the
   * initial scope to that message's account — the auto-loaded conversation
   * must not remap it (it usually predates the entry and would wipe the
   * default). Without an entering message the loaded conversation's stored
   * scope maps instead, so a reopen restores the conversation's boundary.
   */
  const enteringFromMessageRef = useRef(Boolean(currentMessage));
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
  /** Whether the header account (scope) picker popover is open. */
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  /** Anchors the scope picker popover so an outside click closes it. */
  const scopePickerRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    activeIdRef.current = active?.id ?? null;
  }, [active?.id]);
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

  const scope = useMemo(() => agentScopeFor(scopeTarget, accounts), [accounts, scopeTarget]);
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

  // Conversations the user is deleting right now: local rows are dropped
  // optimistically while the server delete is still in flight. Any concurrent
  // refresh must keep these OUT of the list — otherwise the server snapshot,
  // which may still contain them mid-delete, would resurrect rows the user
  // already watched disappear.
  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
  // Tracks conversations created in THIS session (via createAgentConversation).
  // The merge below only keeps a local-only row when it is at least as fresh as
  // the newest server row; a brand-new row can momentarily be omitted by a
  // server snapshot while another, newer row exists, and would otherwise be
  // dropped out of the sidebar (the "conversation flashes away" bug). This set
  // exempts exactly those locally-created rows from being dropped.
  const createdThisSessionRef = useRef<Set<string>>(new Set());

  const refreshConversations = useCallback(async (query = "") => {
    if (demoMode) {
      setConversations([]);
      return;
    }
    const response = await api.agentConversations(query ? new URLSearchParams({ query }).toString() : "");
    setConversations((current) => {
      // When searching, the server result is authoritative for that scope — but
      // it must still not surface a row whose delete is in flight.
      if (query) return response.items.filter((item) => !pendingDeleteIdsRef.current.has(item.id));
      // Otherwise merge instead of blindly replacing: a profile may have just
      // been created / its turn may still be mid-write, so a server snapshot
      // can momentarily omit it and replacing wholesale would flash a
      // disappearing sidebar row. Adopt server rows, but only keep a
      // local-only row when it is at least as fresh as the newest server row
      // (a brand-new / in-flight profile). Anything older — e.g. one deleted
      // here or on another device — is left to the server's authoritative
      // result so it can never resurrect.
      //
      // A locally-deleted row is the one exception to "adopt server rows": the
      // server delete may not have committed yet, so its snapshot can still
      // carry the row. Filter those out so an optimistic delete cannot flicker
      // back into view until the server confirms the removal.
      const pending = pendingDeleteIdsRef.current;
      const newestServer = response.items[0]?.updatedAt ?? "";
      const serverById = new Map(response.items
        .filter((item) => !pending.has(item.id))
        .map((item) => [item.id, item]));
      const merged = [...serverById.values()];
      for (const item of current) {
        if (pending.has(item.id)) continue;
        if (!serverById.has(item.id)) {
          // A row the server snapshot does not (yet) carry. Keep it when it was
          // created this session OR it is at least as fresh as the newest server
          // row; drop it otherwise so an old row deleted on another device
          // cannot resurrect.
          const newThisSession = createdThisSessionRef.current.has(item.id);
          const freshEnough = (item.updatedAt ?? "").localeCompare(newestServer) >= 0;
          if (newThisSession || freshEnough) merged.push(item);
        }
      }
      return merged.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    });
  }, [demoMode]);

  // Streaming conversation state machine (session lifecycle + stream pipeline +
  // background buffer/replay + poll fold-in + run controls), lifted out of this
  // component into useAgentSession. `active` and its setter stay here (the
  // transcript is render state); the hook exercises them via the injected
  // `setActive` boundary so the state machine owns no render state of its own.
  const {
    streaming,
    streamStatus,
    ghostConversationId,
    backgroundRunIds,
    syncBackgroundRuns,
    getSession,
    clearPendingFlush,
    takeBackgroundError,
    clearLiveRunIndicators,
    restoreLiveRunIndicators,
    terminateSession,
    replayBackgroundSession,
    stopStreaming,
    stopGhostRun,
    prepareInterruptToSend,
    runStream,
  } = useAgentSession({
    demoMode,
    active,
    setActive,
    activeIdRef,
    setConversations,
    refreshConversations,
    conversationSearch,
    setPendingMemorySuggestions,
    getT: () => t,
    onMailStateChanged,
  });

  // Clearing a memory suggestion (saved or dismissed) from the UI must also
  // drop it from the backing session: otherwise re-entering the conversation
  // replays it as a fresh undecided chip and the same memory can be saved twice.
  const consumeAgentSuggestion = useCallback((summary: string) => {
    const session = getSession(activeIdRef.current ?? "");
    if (session) session.suggestions = session.suggestions.filter((item) => item !== summary);
  }, [getSession]);

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
      // Resolve the initial conversation before clearing loading so the view
      // never flashes a blank "new conversation" state before restoring the
      // last active (or newest) conversation. `loading` gates only the empty
      // transcript state, not the history list, so the sidebar stays usable
      // while the transcript underneath loads.
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
          if (!enteringFromMessageRef.current) {
            setScopeTarget(scopeTargetForConversation(conversation.scope, accounts));
          }
        } catch {
          // Loading the recovered conversation failed — fall back to the blank
          // state (loading cleared below); the user can retry by clicking a row.
        }
      }
      setLoading(false);
      // The preloaded snapshot can be older than the server (e.g. the panel
      // was closed and reopened before App's close-time refetch landed), so
      // conversations created in the previous panel session would be missing
      // until the next stream/poll event. Reconcile once in the background:
      // a single list fetch converges the sidebar with the server.
      void refreshConversations();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.load"));
    } finally {
      setLoading(false);
    }
  }, [accounts, demoMode, preloadedBootstrap, refreshConversations, t]);

  // Mount-once: loadBootstrap wholesale-adopts the (splash-time) bootstrap
  // snapshot into the sidebar and re-resolves the initial conversation, so
  // re-running it mid-session would flash the whole list away and hijack the
  // active conversation. Its useCallback deps include `accounts`, which App
  // replaces with a new array identity on every silent mail refresh (desktop
  // new-mail pushes arrive while the agent panel is open) — an unguarded
  // effect would reload the bootstrap on every new mail arrival. The
  // error-retry button still re-invokes loadBootstrap deliberately.
  const bootstrapLoadedRef = useRef(false);
  useEffect(() => {
    if (bootstrapLoadedRef.current) return;
    bootstrapLoadedRef.current = true;
    void loadBootstrap();
  }, [loadBootstrap]);

  // Close the permission, model, and scope pickers when the user clicks
  // anywhere outside them or presses Escape.
  useEffect(() => {
    if (!permissionOpen && !modelPickerOpen && !scopePickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (permissionRef.current && !permissionRef.current.contains(event.target as Node)) {
        setPermissionOpen(false);
      }
      if (modelPickerRef.current && !modelPickerRef.current.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
      if (scopePickerRef.current && !scopePickerRef.current.contains(event.target as Node)) {
        setScopePickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPermissionOpen(false);
        setModelPickerOpen(false);
        setScopePickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [permissionOpen, modelPickerOpen, scopePickerOpen]);
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
  // A scope target that points at a deleted account must not leave the
  // composer silently scoped to nothing; fall back to the first account, or to
  // all accounts when none are left.
  useEffect(() => {
    if (scopeTarget === "all") return;
    if (accounts.some((account) => account.id === scopeTarget)) return;
    setScopeTarget(accounts[0]?.id ?? "all");
  }, [accounts, scopeTarget]);

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
    clearLiveRunIndicators();
    // Pending frame-batched deltas belong to the outgoing transcript; drop them
    // so they can never land on a different conversation.
    clearPendingFlush();
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
      const session = getSession(id);
      if (session) replayBackgroundSession(session, conversationView);
      syncBackgroundRuns();
      // Re-surface a background run's cached failure as an error row (consumed
      // once shown). Guarded by the functional updater so a live replay that
      // already rebuilt an error row does not produce a duplicate one.
      const storedError = takeBackgroundError(id);
      if (storedError) {
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
      setScopeTarget(scopeTargetForConversation(conversation.scope, accounts));
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
  }, [accounts, active?.id, activeIdRef, bootstrap?.defaultProviderId, clearLiveRunIndicators, clearPendingFlush, conversationProviders, conversations, getSession, providers, replayBackgroundSession, syncBackgroundRuns, t, takeBackgroundError]);

  const createConversation = useCallback(async () => {
    // Starting a new conversation does not cancel the current one — a live run
    // keeps streaming into its session buffer and resumes if the user returns.
    clearLiveRunIndicators();
    clearPendingFlush();
    setPendingMemorySuggestions([]);
    if (!selectedProvider) {
      setAgentSettingsPane("providers");
      // The early return abandons the switch; restore the live indicators the
      // cleared status above so a still-running reply keeps its affordances.
      restoreLiveRunIndicators(active?.id ?? "");
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
  }, [active?.id, clearLiveRunIndicators, clearPendingFlush, restoreLiveRunIndicators, selectedProvider, syncBackgroundRuns]);

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
    const targetSet = new Set(targets);
    const pending = pendingDeleteIdsRef.current;
    // Optimistically drop the rows up front and mark them pending so any
    // concurrent refresh (heartbeat / pickup poll / stream completion) cannot
    // resurrect them from a server snapshot that predates the committed delete.
    // A failed delete clears the mark and the authoritative snapshot restores it.
    for (const id of targets) pending.add(id);
    setConversations((current) => current.filter((item) => !targetSet.has(item.id)));
    const deleted: string[] = [];
    const errors: unknown[] = [];
    try {
      for (const id of targets) {
        try {
          await api.deleteAgentConversation(id);
          deleted.push(id);
        } catch (error) {
          errors.push(error);
        } finally {
          // The server either confirmed the delete or refused it — either way
          // the row is no longer something a refresh must keep hidden.
          pending.delete(id);
        }
      }
      syncBackgroundRuns();
      for (const id of deleted) {
        // A deleted conversation must not keep its revoked-id marks: recreating
        // a conversation with the same id would start with messages hidden.
        writeRevokedIds(id, new Set());
        // Detach the session buffer (abort + cancel server run + clear cached
        // failure), deleting only if the slot is still bound to the captured
        // run so a re-send during an in-flight delete is never stranded.
        terminateSession(id);
      }
      const deletedSet = new Set(deleted);
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
        // Failed deletes were optimistically hidden; the pending marks are clear,
        // so refresh once to let the server's authoritative snapshot restore them.
        void refreshConversations(conversationSearch);
      }
    } finally {
      setMultiDeleteBusy(false);
    }
  }, [active, activeIdRef, conversationSearch, conversations, refreshConversations, selectConversation, syncBackgroundRuns, t]);

  // Token batching, reveal pacing and session-buffer routing
  // (flushPendingStreamPieces / enqueueStreamPiece / streamPacingRef /
  // pendingStreamPiecesRef / streamRafRef) have been lifted into the session
  // hook (useAgentSession); the component no longer owns them.

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
    // cancels that run (via its own controller) before the new one starts; a
    // pickup run (no local controller) is cancelled server-side. Owned by the
    // session hook's prepareInterruptToSend.
    prepareInterruptToSend();
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
        if (conversation) createdThisSessionRef.current.add(conversation.id);
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
    const userMessage: AgentMessage = { id: newLocalId("user"), role: "user", content: userText, createdAt: currentTime(), state: "complete", citations: [], toolActivities: [], ...(attachments.length > 0 ? { attachments } : {}), ...(truncatedQuote ? { quote: truncatedQuote } : {}), ...(mailReferences.length > 0 ? { references: mailReferences.map((reference) => ({ id: reference.id, subject: reference.subject })) } : {}) };
    const assistantMessage: AgentMessage = { id: newLocalId("assistant"), role: "assistant", content: "", createdAt: currentTime(), state: "streaming", citations: [], toolActivities: [] };
    setComposer("");
    setAttachedFiles([]);
    setQuoteContext(null);
    setLoadError(null);
    setConfirmationErrors({});
    // Sending a new message dismisses the revoke notice immediately.
    setRevokeNoticeUntil(null);
    setRevokeFailed(null);
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
    // Run lifecycle — slot rebind, pacing reset, CONFLICT retry, event
    // consumption, and teardown (streaming flag / session-buffer cleanup) — lives
    // inside the session hook's runStream.
    const streamPayload: Parameters<typeof api.streamAgentMessage>[1] = {
      content: userText,
      providerId: selectedProvider.id,
      mode,
      scope,
      // Let the server persist this turn under the optimistic row's id: a
      // revoke issued seconds later (the recall-and-resend flow) then addresses
      // a row the server actually knows, instead of 404-ing on a client-only
      // id and rolling the optimistic revoke back (the "revoked messages
      // came back" bug).
      clientMessageId: userMessage.id,
      ...(truncatedQuote ? { quote: truncatedQuote } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(mailReferences.length > 0 ? { references: mailReferences.map((reference) => ({ id: reference.id, subject: reference.subject })) } : {}),
    };
    await runStream({ conversation, assistantMessage, streamPayload });
  }, [active, attachedFiles, composer, mailReferences, mode, prepareInterruptToSend, quoteContext, runStream, scope, selectedProvider, t]);

  // Slash command menu: while the composer holds a bare "/token" the matching
  // commands are offered. Parameterless commands send immediately; commands
  // with parameters are completed into the composer for editing. Expansion
  // itself happens on the server, which validates the controlled command set.
  // Slash commands are mail-operation scoped: only the mail-assistant mode
  // builds the menu, plain chat ignores the leading "/".
  const slashMenu = useMemo(() => mode === "agent" ? buildSlashMenu(composer, { streaming, dismissed: slashDismissed }) : null, [composer, slashDismissed, mode, streaming]);
  const slashVisible = slashMenu !== null && slashMenu.length > 0;
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

  // /@ mail mention menu: when the composer holds a "/@..." prefix the menu
  // lists mail to pull into context (latest across all accounts, or an FTS
  // search once a term follows). Introducing a mail adds a reference chip and
  // clears the composer; a reference from outside the account scope widens the
  // scope so the agent may actually read it.
  const mentionTerm = useMemo(
    () => (mode === "agent" ? mentionQuery(composer, { streaming, dismissed: mentionDismissed, demoMode }) : null),
    [composer, demoMode, mentionDismissed, mode, streaming],
  );
  mentionTermRef.current = mentionTerm;
  const mentionOpen = mentionTerm !== null;
  const activeMentionIndex = mentionActiveIndex(mentionItems, mentionIndex);
  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        mentionLoadingRef.current = true;
        setMentionLoading(true);
        try {
          const term = (mentionTermRef.current ?? "").trim();
          const query = term
            ? `q=${encodeURIComponent(term)}&scope=all&pageSize=${MENTION_PAGE_SIZE}`
            : `pageSize=${MENTION_PAGE_SIZE}`;
          const page = await api.messages(query);
          if (cancelled) return;
          setMentionItems(page.items.map(mentionItemFor));
          setMentionIndex(0);
          mentionPageRef.current = 1;
        } catch {
          if (!cancelled) setMentionItems([]);
        } finally {
          mentionLoadingRef.current = false;
          if (!cancelled) setMentionLoading(false);
        }
      })();
    }, MENTION_QUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Each composer edit changes the term and re-arms the debounce; opening and
    // closing the menu also (de)activates the fetch.
  }, [mentionOpen, mentionTerm]);
  useEffect(() => {
    if (!mentionOpen) {
      setMentionItems([]);
      setMentionLoading(false);
      setMentionIndex(0);
      mentionPageRef.current = 1;
    }
  }, [mentionOpen]);
  const loadMoreMentions = useCallback(async () => {
    if (mentionLoadingRef.current || !mentionOpen) return;
    const term = (mentionTermRef.current ?? "").trim();
    const nextPage = mentionPageRef.current + 1;
    mentionLoadingRef.current = true;
    setMentionLoading(true);
    try {
      const query = term
        ? `q=${encodeURIComponent(term)}&scope=all&pageSize=${MENTION_PAGE_SIZE}&page=${nextPage}`
        : `pageSize=${MENTION_PAGE_SIZE}&page=${nextPage}`;
      const page = await api.messages(query);
      const fresh = page.items.map(mentionItemFor);
      setMentionItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...fresh.filter((item) => !seen.has(item.id))];
      });
      mentionPageRef.current = nextPage;
    } catch {
      // A failed page keeps the current results; scrolling again retries.
    } finally {
      mentionLoadingRef.current = false;
      setMentionLoading(false);
    }
  }, [mentionOpen]);
  const introduceMailReference = useCallback((item: MentionItem) => {
    const alreadyReferenced = mailReferences.some((ref) => ref.id === item.id);
    if (alreadyReferenced) {
      setComposer("");
      setMentionDismissed(true);
      return;
    }
    if (mailReferences.length >= MAX_MAIL_REFERENCES) {
      setMentionLimitReached(true);
      return;
    }
    setMailReferences((current) => [...current, { id: item.id, subject: item.subject, accountId: item.accountId, accountEmail: item.accountEmail }]);
    // A reference from outside the current account scope widens the boundary
    // so the agent may read the mail — scope is account-level, the reference
    // must not sit outside it.
    setScopeTarget((target) => (target !== "all" && target !== item.accountId ? "all" : target));
    setComposer("");
    setMentionDismissed(true);
  }, [mailReferences]);
  const removeMailReference = useCallback((id: string) => {
    setMailReferences((current) => current.filter((ref) => ref.id !== id));
  }, []);
  // A message that becomes current while the workspace stays mounted (the mail
  // list cannot be reached while the panel covers it, but the prop may change)
  // joins the reference set — the entering message is already seeded at mount.
  useEffect(() => {
    if (!currentMessage) return;
    setMailReferences((current) => (current.some((ref) => ref.id === currentMessage.id) ? current : [...current, mailReferenceFor(currentMessage)]));
  }, [currentMessage]);

  const permissionOptions: Array<{ level: AgentAccessLevel; label: string; hint: string; detail: string; features: string[]; icon: ReactNode }> = [
    { level: "read-only", label: t("agent.permission.readOnly"), hint: t("agent.permission.readOnly.hint"), detail: t("agent.permission.readOnly.detail"), features: [t("agent.permission.readOnly.feature1"), t("agent.permission.readOnly.feature2"), t("agent.permission.readOnly.feature3")], icon: <Eye size={12} /> },
    { level: "send-confirmed", label: t("agent.permission.confirmed"), hint: t("agent.permission.confirmed.hint"), detail: t("agent.permission.confirmed.detail"), features: [t("agent.permission.confirmed.feature1"), t("agent.permission.confirmed.feature2"), t("agent.permission.confirmed.feature3")], icon: <ShieldCheck size={12} /> },
    { level: "full-access", label: t("agent.permission.fullAccess"), hint: t("agent.permission.fullAccess.hint"), detail: t("agent.permission.fullAccess.detail"), features: [t("agent.permission.fullAccess.feature1"), t("agent.permission.fullAccess.feature2"), t("agent.permission.fullAccess.feature3")], icon: <Zap size={12} /> },
  ];
  const cloudMailContextBlocked = Boolean(selectedProvider?.cloud && !selectedProvider.cloudContentConsent);
  const currentPermissionLabel = permissionOptions.find((option) => option.level === agentAccessLevel)?.label;
  const permissionPopover = useMountedVisible(permissionOpen);
  const modelPopover = useMountedVisible(modelPickerOpen);
  const scopePopover = useMountedVisible(scopePickerOpen);
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
  /** Revoke failed: a categorized error bar above the composer. Separate from
   *  the transcript-level loadError panel so the two failure classes read
   *  distinctly. Cleared on send or dismiss. */
  const [revokeFailed, setRevokeFailed] = useState<string | null>(null);
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
    const refillText = revokeTarget?.role === "user" ? revokeTarget.content : "";
    const composerBeforeRefill = composerRef.current?.value ?? "";
    if (revokeTarget?.role === "user" && revokeTarget.content) {
      setComposer(revokeTarget.content);
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
    setRevokeNoticeUntil(Date.now() + REVOKE_NOTICE_SECONDS * 1000);
    // Server reconciliation: idempotent, duplicates ignored while in flight.
    pendingRevokeIdsRef.current = new Set(pendingRevokeIdsRef.current).add(messageId);
    void api.revokeAgentMessage(conversationId, messageId, true).catch((error) => {
      // Roll back the optimistic marks so the transcript matches the server.
      setActive((current) => {
        if (!current) return current;
        const revokedIds = new Set(readRevokedIds(current.id));
        revokedSet.forEach((id) => revokedIds.delete(id));
        writeRevokedIds(current.id, revokedIds);
        return { ...current, messages: current.messages.map((message) => (revokedSet.has(message.id) ? { ...message, revoked: false } : message)) };
      });
      // Undo the composer refill unless the user has already typed over it:
      // a lingering refilled message resent later is how duplicates appeared.
      if (refillText && composerRef.current?.value === refillText) {
        setComposer(composerBeforeRefill);
      }
      setRevokeNoticeUntil(null);
      setRevokeFailed(revokeFailureMessage(error, t));
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
            <div key={conversation.id} className={`agent-conversation-row ${active?.id === conversation.id ? "active" : ""}${selectionMode ? " selectable" : ""}${selectionMode && selectedConversationIds.has(conversation.id) ? " selected" : ""}`} onContextMenu={(event) => openConversationMenu(event, conversation.id)}>
              {selectionMode && <button className={`agent-row-check ${selectedConversationIds.has(conversation.id) ? "checked" : ""}`} type="button" aria-label={t("agent.conversation.toggleSelect")} aria-pressed={selectedConversationIds.has(conversation.id)} disabled={backgroundRunIds.has(conversation.id) || (active?.id === conversation.id && streaming)} onClick={() => toggleConversationSelected(conversation.id)}><span className="agent-row-check-box"><Check size={12} /></span></button>}
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
            <div className="agent-scope-picker-wrap" ref={scopePickerRef}>
              <button type="button" className="agent-scope-picker" onClick={() => setScopePickerOpen((open) => !open)} aria-expanded={scopePickerOpen} aria-haspopup="menu" aria-controls="agent-scope-picker" aria-label={t("agent.scope.switch")} data-tooltip={t("agent.scope.switch")}>
                {scopeTarget === "all" ? <UsersRound size={13} /> : <Mail size={13} />}
                <span>{scopeTarget === "all" ? t("agent.scope.all") : (accounts.find((account) => account.id === scopeTarget)?.email ?? scopeTarget)}</span>
                <ChevronDown size={11} className={`agent-scope-chevron${scopePickerOpen ? " open" : ""}`} aria-hidden="true" />
              </button>
              {scopePopover.mounted && (
                <AgentPickerPopover id="agent-scope-picker" anchor="right" visible={scopePopover.visible} label={t("agent.scope.label")}>
                  {accounts.map((account) => {
                    const isCurrent = scopeTarget === account.id;
                    return (
                      <button key={account.id} type="button" role="menuitemradio" aria-checked={isCurrent} className={`agent-popover-option agent-scope-option${isCurrent ? " active" : ""}`} onClick={() => { setScopePickerOpen(false); if (!isCurrent) setScopeTarget(account.id); }}>
                        <span className="agent-popover-option-icon" aria-hidden="true"><Mail size={12} /></span>
                        <span className="agent-popover-option-main"><strong>{account.email}</strong></span>
                        {isCurrent && <Check size={13} className="agent-popover-option-check" />}
                      </button>
                    );
                  })}
                  {accounts.length > 0 && <div className="agent-popover-divider" role="separator" />}
                  <button type="button" role="menuitemradio" aria-checked={scopeTarget === "all"} className={`agent-popover-option agent-scope-option${scopeTarget === "all" ? " active" : ""}`} onClick={() => { setScopePickerOpen(false); setScopeTarget("all"); }}>
                    <span className="agent-popover-option-icon" aria-hidden="true"><UsersRound size={12} /></span>
                    <span className="agent-popover-option-main"><strong>{t("agent.scope.all")}</strong><small>{t("agent.scope.all.tooltip")}</small></span>
                    {scopeTarget === "all" && <Check size={13} className="agent-popover-option-check" />}
                  </button>
                </AgentPickerPopover>
              )}
            </div>
            <button className="agent-mobile-conversations-button" type="button" aria-label={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} aria-expanded={mobileConversationsOpen} data-tooltip={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} onClick={() => setMobileConversationsOpen((open) => !open)}><PanelLeftClose size={17} /></button>
            {!hasConfiguredProvider ? <button ref={providerSettingsTriggerRef} className="agent-configure-provider-action" type="button" onClick={() => setAgentSettingsPane("providers")}><Wrench size={15} />{t("agent.providers.configure")}</button> : null}
            {hasConfiguredProvider && <button ref={providerSettingsTriggerRef} className="icon-button" type="button" onClick={() => setAgentSettingsPane("providers")} aria-label={t("agent.provider.settings")} data-tooltip={t("agent.provider.settings")}><Wrench size={17} /></button>}
            <button className="icon-button" type="button" onClick={onClose} aria-label={t("agent.workspace.close")} data-tooltip={t("agent.workspace.close")}><ArrowLeft size={20} strokeWidth={2.4} /></button>
          </div>
        </header>

        <div className="agent-context-strip">
          <div className="agent-mode-switch strip-mode" role="group" aria-label={t("agent.mode.label")} data-mode={mode}>
            <span className="agent-mode-thumb" aria-hidden="true" />
            <button type="button" className={mode === "agent" ? "active" : ""} aria-pressed={mode === "agent"} onClick={() => setMode("agent")}><Bot size={14} />{t("agent.mode.agent")}</button>
            <button type="button" className={mode === "chat" ? "active" : ""} aria-pressed={mode === "chat"} onClick={() => setMode("chat")}><MessageCircle size={14} />{t("agent.mode.chat")}</button>
          </div>
          {selectedProvider?.cloud && !selectedProvider.cloudContentConsent && <span className="agent-privacy-notice"><ShieldAlert size={14} />{t("agent.provider.consentRequired")}</span>}
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
              onOpenMessage={onOpenMessage}
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
              onOpenMessage={onOpenMessage}
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
              <button type="button" role="menuitem" onClick={() => { setQuoteContext(contextMenu.text); setContextMenu(null); window.requestAnimationFrame(() => composerRef.current?.focus()); }}><Quote size={14} /><span>{t("agent.message.followUp")}</span></button>
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
          {revokeFailed && (
            <div className="agent-revoke-notice error" role="alert">
              <CircleAlert size={14} />
              <span>{revokeFailed}</span>
              <button type="button" className="agent-revoke-dismiss" onClick={() => setRevokeFailed(null)} aria-label={t("common.dismiss")}><X size={12} /></button>
            </div>
          )}
          {pendingConfirmation && <AgentConfirmationCard
            confirmation={pendingConfirmation}
            desktopConfirmationAvailable={desktopConfirmationAvailable}
            resolutionError={confirmationErrors[pendingConfirmation.id]}
            onDecision={demoMode ? (decision) => resolveDemoConfirmation(pendingConfirmation.id, decision) : undefined}
            expiresAt={Number.isFinite(confirmationDeadline) && confirmationDeadline > 0 ? confirmationDeadline : undefined}
            onExpire={expirePendingConfirmation}
          />}
          {mailReferences.length > 0 && (
            <div className="agent-reference-chips">
              {mailReferences.map((reference) => (
                <span key={reference.id} className="agent-reference-chip">
                  <button type="button" className="agent-reference-chip-open" onClick={() => onOpenMessage(reference.id)} title={reference.subject} data-tooltip={t("agent.reference.open")}><Mail size={12} /><span>{reference.subject || t("agent.reference.noSubject")}</span><span className="agent-reference-chip-account">{reference.accountEmail}</span></button>
                  <button type="button" className="agent-reference-chip-remove" onClick={() => removeMailReference(reference.id)} aria-label={t("agent.reference.dismiss")} data-tooltip={t("agent.reference.dismiss")}><X size={11} /></button>
                </span>
              ))}
            </div>
          )}
          <div className={`agent-composer${streaming ? " streaming" : ""}`}>
            <button className={`agent-scroll-to-bottom ${showScrollToBottom ? "visible" : ""}`} type="button" onClick={scrollToBottom} aria-label={t("agent.composer.scrollToBottom")}><ChevronDown size={17} /></button>
            <input ref={fileInputRef} type="file" multiple onChange={(e) => void handleFileSelect(e)} accept=".txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.py,.js,.ts,.tsx,.jsx,.css,.scss,.less,.yaml,.yml,.log,.rtf,.ini,.cfg,.conf,.sh,.bash,.zsh,.sql,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.vue,.svelte,.pdf,.docx,.pptx" style={{ display: "none" }} />
            <label className="visually-hidden" htmlFor="agent-composer">{t("agent.composer.label")}</label>
            <textarea id="agent-composer" ref={composerRef} value={composer} onChange={(event) => { setComposer(event.target.value); setSlashDismissed(false); setMentionDismissed(false); setMentionLimitReached(false); }} onKeyDown={(event) => {
              const composing = (event.nativeEvent as KeyboardEvent).isComposing;
              // While the slash menu is open, arrows/tab/enter drive it instead
              // of the composer's default editing and send behavior.
              if (slashMenu && !composing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((index) => (index + delta + slashMenu.length) % slashMenu.length);
                  requestAnimationFrame(() => document.getElementById("agent-slash-menu")?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
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
              // The /@ mention menu is structurally exclusive with the slash
              // menu (its prefix is not a slash-token), so a second branch drives
              // arrows/tab/enter/escape the same way.
              if (mentionOpen && !composing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (mentionItems.length === 0) return;
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setMentionIndex((index) => (index + delta + mentionItems.length) % mentionItems.length);
                  requestAnimationFrame(() => document.getElementById("agent-mention-menu")?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  const active = mentionItems[activeMentionIndex];
                  if (active) introduceMailReference(active);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMentionDismissed(true);
                  setComposer("");
                  return;
                }
              }
              // Ignore Enter while an IME composition is active (e.g. confirming
              // pinyin) so the message is not sent mid-composition.
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                void sendMessage();
              }
            }} placeholder={t("agent.composer.placeholder")} disabled={composerDisabled} rows={1} aria-expanded={(slashMenu !== null && slashMenu.length > 0) || mentionOpen} aria-controls={slashMenu !== null && slashMenu.length > 0 ? "agent-slash-menu" : mentionOpen ? "agent-mention-menu" : undefined} aria-activedescendant={slashMenu !== null && slashMenu.length > 0 ? (activeSlashIndex >= 0 ? `agent-slash-menu-item-${activeSlashIndex}` : undefined) : mentionOpen && mentionItems.length > 0 ? (activeMentionIndex >= 0 ? `agent-mention-menu-item-${activeMentionIndex}` : undefined) : undefined} />
            {slashMenu && slashMenu.length > 0 && (
              <div className="agent-slash-menu" id="agent-slash-menu" role="listbox" aria-label={t("agent.commands.label")}>
                {slashMenu.map((item, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`agent-slash-menu-item-${index}`}
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
            {mentionOpen && (
              <div className="agent-mention-menu" id="agent-mention-menu" role="listbox" aria-label={t("agent.mention.label")} onScroll={(event) => {
                const el = event.currentTarget;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) void loadMoreMentions();
              }}>
                {mentionLoading && mentionItems.length === 0 ? (
                  <div className="agent-mention-empty"><LoaderCircle size={13} className="spin" /><span>{t("agent.mention.loading")}</span></div>
                ) : mentionItems.length === 0 ? (
                  <div className="agent-mention-empty"><span>{t("agent.mention.empty")}</span></div>
                ) : (
                  mentionItems.map((item, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`agent-mention-menu-item-${index}`}
                      aria-selected={index === activeMentionIndex}
                      key={item.id}
                      className={`agent-mention-item${index === activeMentionIndex ? " selected" : ""}`}
                      onMouseDown={(event) => { event.preventDefault(); introduceMailReference(item); }}
                    >
                      <span className="agent-mention-avatar" aria-hidden="true">{(item.subject ?? "").trim() ? item.subject!.trim()[0].toUpperCase() : "?"}</span>
                      <span className="agent-mention-main">
                        <span className="agent-mention-subject">{item.subject || t("agent.reference.noSubject")}</span>
                        <span className="agent-mention-meta">{item.sender}<span aria-hidden="true">{" · "}</span>{item.accountEmail}</span>
                      </span>
                    </button>
                  ))
                )}
                {mentionLimitReached && <div className="agent-mention-limit" role="status">{t("agent.mention.maxReached")}</div>}
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
                {(streaming || ghostConversationId === active?.id) && !composer.trim() && <button className="agent-send-button stop" type="button" onClick={ghostConversationId === active?.id ? stopGhostRun : stopStreaming} aria-label={t("agent.composer.stop")} data-tooltip={t("agent.composer.stop")}><Square size={12} fill="currentColor" /></button>}
                {(!(streaming || ghostConversationId === active?.id) || Boolean(composer.trim())) && <button className="agent-send-button" type="button" disabled={sendDisabled || ghostConversationId === active?.id} onClick={() => void sendMessage()} aria-label={t("agent.composer.send")} data-tooltip={t("agent.composer.send")}><ArrowUp size={16} strokeWidth={2.5} /></button>}
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
