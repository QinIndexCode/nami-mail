import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from "react";
import {
  Bell,
  Bot,
  Cable,
  Cpu,
  Filter,
  KeyRound,
  Laptop,
  Languages,
  LoaderCircle,
  Palette,
  RefreshCw,
  RotateCcw,
  Search,
  SearchX,
  Server,
  Trash2,
  Undo2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { api, type TranslationConfiguration, type TranslationProviderId } from "./api";
import type { AgentBootstrap, AgentProviderList, ExternalPairingSummary } from "./agentTypes";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import { searchSettings } from "./settings/settings-search";

import FilterRulesSection from "./FilterRulesSection";
import AgentMemoryDialog from "./AgentMemoryDialog";
import AutoReplyPendingDialog from "./AutoReplyPendingDialog";
import AutoReplyDecisionsDialog from "./AutoReplyDecisionsDialog";
import { useI18n } from "./i18n";
import { playNotificationSound, primeNotificationSound } from "./sounds";
import {
  hasUnsavedTranslationConfiguration,
  translationConfigurationErrorMessage,
} from "./translationPresentation";
import { presentUpdateSnapshot } from "./updatePresentation";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useDismissTransition } from "./hooks/useDismissTransition";
import type {
  Account,
  AgentAccessLevel,
  AppSettings,
  AppSettingsPatch,

  BackgroundPreset,


  NotificationSound,
} from "./types";
import { defaultAppSettings } from "./types";
import { FormNotice, type Notice } from "./FormNotice";
import {
  errorMessage,
  backgroundContentTypeForFile,
  revokeDemoObjectUrl,

  expandedThemedSelectOwnsEscape,
  maxBackgroundUploadBytes,
  type PendingSettingsConfirmation,
} from "./settings/settings-utils";
import {
  SETTINGS_CATEGORY_STORAGE_KEY,
  SETTINGS_NAV_GROUPS,
  readStoredSettingsCategory,
  settingsNavGroupLabelKeys,
  type SettingsCategoryId,
} from "./settings/settings-categories";
import SettingsAgentSection from "./settings/SettingsAgentSection";
import SettingsModelsSection from "./settings/SettingsModelsSection";
import SettingsConnectionsSection from "./settings/SettingsConnectionsSection";
import SettingsTranslationSection from "./settings/SettingsTranslationSection";
import SettingsAppearanceSection from "./settings/SettingsAppearanceSection";
import {
  SettingsDesktopPanel,
  SettingsLanguagePanel,
  SettingsNotificationsPanel,
  SettingsSyncPanel,
} from "./settings/SettingsCategoryPanels";

const isDesktopRuntime = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("desktop") === "1";

/** Sidebar icon + label per category; grouping and order live in settings-categories. */
const categoryMeta: Record<SettingsCategoryId, { icon: LucideIcon; labelKey: string }> = {
  language: { icon: Languages, labelKey: "language.title" },
  appearance: { icon: Palette, labelKey: "settings.appearance.title" },
  notifications: { icon: Bell, labelKey: "settings.notifications.title" },
  desktop: { icon: Laptop, labelKey: "settings.desktop.title" },
  sync: { icon: RefreshCw, labelKey: "settings.sync.title" },
  filters: { icon: Filter, labelKey: "settings.nav.filters.title" },
  models: { icon: Cpu, labelKey: "settings.nav.models.title" },
  mcp: { icon: Server, labelKey: "settings.nav.mcp.title" },
  connections: { icon: Cable, labelKey: "settings.nav.connections.title" },
  agent: { icon: Bot, labelKey: "agent.launch" },
  translation: { icon: KeyRound, labelKey: "settings.translation.title" },
};

const visibleNavGroups = SETTINGS_NAV_GROUPS
  .map((group) => ({ ...group, items: group.items.filter((id) => isDesktopRuntime || id !== "desktop") }))
  .filter((group) => group.items.length > 0);


export type SettingsModalProps = {
  settings: AppSettings;
  accounts: Account[];
  onClose: () => void;
  /** Receives the fully persisted settings result, not a partial patch. */
  onSettingsChange: (next: AppSettings) => void | Promise<void>;
  /** Lets the host own native desktop notification testing when desired. */
  onTestNotification?: (settings: AppSettings) => void | Promise<void>;
  /** Lets the host share its notification-audio policy with this modal. */
  onTestSound?: (sound: NotificationSound) => void | Promise<void>;
  /** Refreshes reader translation status after service configuration changes. */
  onTranslationConfigurationChanged?: () => void | Promise<void>;
  /** Seeds the embedded models panel's first frame from the App-level agent
   *  bootstrap preload; the panel still refetches the list when it mounts. */
  agentProviderSeed?: Pick<AgentBootstrap, "providers" | "defaultProviderId">;
  /** Notified when the embedded models panel saves or deletes a provider, so
   *  the host can sync the workspace (composer badge, model picker). */
  onAgentProviderListChanged?: (providers: AgentProviderList) => void;
  /** Deep link: when `nonce` changes — including on a cold mount with the
   *  request already present — the modal switches to `category`. The nonce
   *  beats the persisted-category restore. */
  categoryRequest?: { category: SettingsCategoryId; nonce: number } | null;
  /** Visible control used only when the original trigger disappears, such as a closed mobile drawer. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Demo settings are intentionally in-memory and are never sent to the local API. */
  demoMode?: boolean;
};

const restoreDefaultsPatch: AppSettingsPatch = {
  theme: defaultAppSettings.theme,
  locale: defaultAppSettings.locale,
  backgroundPreset: defaultAppSettings.backgroundPreset,
  backgroundIntensity: defaultAppSettings.backgroundIntensity,
  notificationsEnabled: defaultAppSettings.notificationsEnabled,
  notifyWhenFocused: defaultAppSettings.notifyWhenFocused,
  notificationSound: defaultAppSettings.notificationSound,
  refreshIntervalSeconds: defaultAppSettings.refreshIntervalSeconds,
  realtimePushEnabled: defaultAppSettings.realtimePushEnabled,
  closeBehavior: defaultAppSettings.closeBehavior,
  launchAtStartup: defaultAppSettings.launchAtStartup,
  globalShortcutEnabled: defaultAppSettings.globalShortcutEnabled,
  agentToolRoundLimit: defaultAppSettings.agentToolRoundLimit,
  listDensity: defaultAppSettings.listDensity,
  avatarGravatarEnabled: defaultAppSettings.avatarGravatarEnabled,
  avatarBimiEnabled: defaultAppSettings.avatarBimiEnabled,
};


export default function SettingsModal({
  settings,
  accounts,
  onClose,
  onSettingsChange,
  onTestNotification,
  onTestSound,
  onTranslationConfigurationChanged,
  agentProviderSeed,
  onAgentProviderListChanged,
  categoryRequest = null,
  fallbackFocusRef,
  demoMode = false,
}: SettingsModalProps) {
  const { locale, locales, setLocale, t, formatDate } = useI18n();
  const [currentSettings, setCurrentSettings] = useState(settings);
  const [notice, setNotice] = useState<Notice>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [intensityDraft, setIntensityDraft] = useState(settings.backgroundIntensity);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingSettingsConfirmation | null>(null);
  /** Holds the pending access-level patch while the full-access warning is open. */
  const [pendingFullAccess, setPendingFullAccess] = useState<{ patch: AppSettingsPatch; successMessage: string | null } | null>(null);
  const [backgroundUploadError, setBackgroundUploadError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateSnapshot | null>(null);
  // Bumped by every pushed update-status event: an action's own snapshot was
  // taken before any event broadcast while it ran, so it may only win when no
  // event intervened (the same rule the App-level footer follows).
  const updateEventSeqRef = useRef(0);
  const [updateActionBusy, setUpdateActionBusy] = useState<"check" | "download" | "skip" | "snooze" | "install" | null>(null);
  const [updateSnoozeMinutes, setUpdateSnoozeMinutes] = useState(24 * 60);
  const [translationConfiguration, setTranslationConfiguration] = useState<TranslationConfiguration | null>(null);
  const [translationConfigurationLoading, setTranslationConfigurationLoading] = useState(!demoMode);
  const [translationConfigurationLoadAttempt, setTranslationConfigurationLoadAttempt] = useState(0);
  const [translationConfigurationError, setTranslationConfigurationError] = useState<unknown>(null);
  const [translationEndpoint, setTranslationEndpoint] = useState("");
  const [translationApiKey, setTranslationApiKey] = useState("");
  const [translationApiKeyVisible, setTranslationApiKeyVisible] = useState(false);
  const [translationTimeoutMs, setTranslationTimeoutMs] = useState(25_000);
  const [translationPrimary, setTranslationPrimary] = useState<TranslationProviderId>("google");
  const [translationBackup, setTranslationBackup] = useState<TranslationProviderId>("mymemory");
  const [autoReplyDialogOpen, setAutoReplyDialogOpen] = useState(false);
  const [autoReplyDecisionsOpen, setAutoReplyDecisionsOpen] = useState(false);
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [externalGuideCopied, setExternalGuideCopied] = useState<string | null>(null);
  const [externalPairings, setExternalPairings] = useState<ExternalPairingSummary[] | null>(null);
  const [externalPairingsError, setExternalPairingsError] = useState<unknown>(null);
  // Reported by the models panel: a form dialog stacked over it, and whether a
  // save / connection check is running there. Both gate this dialog's own close
  // paths, because a models save also checks the connection and can take tens
  // of seconds — closing now would hide the result the user is waiting for.
  const [modelsOverlayOpen, setModelsOverlayOpen] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [connectionsOverlayOpen, setConnectionsOverlayOpen] = useState(false);
  const [connectionsBusy, setConnectionsBusy] = useState(false);
  const [filtersOverlayOpen, setFiltersOverlayOpen] = useState(false);
  // One visible panel at a time; the sidebar switches categories instead of
  // scrolling. The choice persists so reopening the modal lands where the user
  // left off, and a stored "desktop" is ignored on browser runtimes. A deep
  // link present at mount wins over the persisted category.
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(() => categoryRequest?.category ?? readStoredSettingsCategory(isDesktopRuntime));
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, activeCategory);
    } catch {
      // Storage may be unavailable (private mode); the choice simply does not persist.
    }
    setNotice(null);
  }, [activeCategory]);
  // Deep-link requests arriving while the modal is open (workspace "configure
  // model" buttons): each nonce is applied once. The ref is seeded with the
  // mount-time nonce, which the initial state above already adopted.
  const lastCategoryRequestNonceRef = useRef<number | null>(categoryRequest?.nonce ?? null);
  useEffect(() => {
    if (!categoryRequest || lastCategoryRequestNonceRef.current === categoryRequest.nonce) return;
    // A models form, connections dialog or filter-rules modal stacked over the panel owns the interaction.
    // Switching now would unmount the panel under it and drop its draft without ever asking.
    // The nonce is deliberately not consumed: the deep link lands as soon as the overlay is gone.
    if (modelsOverlayOpen || filtersOverlayOpen || connectionsOverlayOpen) return;
    lastCategoryRequestNonceRef.current = categoryRequest.nonce;
    setActiveCategory(categoryRequest.category);
    if (settingsBody.current) settingsBody.current.scrollTop = 0;
  }, [categoryRequest, modelsOverlayOpen, filtersOverlayOpen, connectionsOverlayOpen]);
  // The embedded models panel hosts both inner tabs (providers / MCP servers);
  // switching them swaps the body in place so the panel never remounts.
  const [externalPairingsReload, setExternalPairingsReload] = useState(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  // Portal host for the models forms (see SettingsModelsSection): the panel
  // they used to render under keeps a transformed ancestor alive through its
  // entry animation, which would capture their `position: fixed` backdrop.
  const settingsBackdrop = useRef<HTMLDivElement>(null);
  const settingsBody = useRef<HTMLDivElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const backgroundAlert = useRef<HTMLElement>(null);
  const activeLocale = currentSettings.locale || locale;
  const controlsBusy = Boolean(busyAction || updateActionBusy === "install" || modelsBusy || connectionsBusy);
  // While a models form or filter rule modal is stacked over the panel, close is owned by that form.
  // The header X and "done" therefore look like live buttons that silently do
  // nothing: they show as disabled and say why.
  const formsOverlayOpen = modelsOverlayOpen || filtersOverlayOpen || connectionsOverlayOpen;
  const closeBlocked = controlsBusy || formsOverlayOpen;
  const closeBlockedHint = (modelsOverlayOpen || connectionsOverlayOpen) ? t("settings.models.formOpenHint") : null;
  const updatePresentation = updateStatus ? presentUpdateSnapshot(updateStatus, t) : null;
  const hasUnsavedTranslationDraft = hasUnsavedTranslationConfiguration(translationConfiguration, {
    endpoint: translationEndpoint,
    apiKey: translationApiKey,
    timeoutMs: translationTimeoutMs,
    primary: translationPrimary,
    backup: translationBackup,
  });
  const pendingTranslationDiscard = pendingConfirmation === "discard-translation-changes"
    || pendingConfirmation === "discard-translation-changes-and-open-models";

  const dismissBackgroundUploadError = () => {
    setBackgroundUploadError(null);
  };

  const { closing, requestClose: requestExit } = useDismissTransition(() => {
    onClose();
  });
  const { closing: confirmClosing, requestClose: requestConfirmClose, reset: resetConfirmClosing } = useDismissTransition(() => setPendingConfirmation(null));
  const { closing: alertClosing, requestClose: requestAlertClose, reset: resetAlertClosing } = useDismissTransition(dismissBackgroundUploadError);

  const requestClose = useCallback(() => {
    if (controlsBusy) return;
    // Same yield Escape already makes below: a stacked models form, connections dialog or filter rules modal
    // owns the interaction. Closing here would unmount the panel under it and drop the
    // draft it holds without ever asking.
    if (modelsOverlayOpen || filtersOverlayOpen || connectionsOverlayOpen) return;
    if (hasUnsavedTranslationDraft) {
      resetConfirmClosing();
      setPendingConfirmation("discard-translation-changes");
      return;
    }
    requestExit();
  }, [connectionsOverlayOpen, controlsBusy, filtersOverlayOpen, hasUnsavedTranslationDraft, modelsOverlayOpen, requestExit, resetConfirmClosing]);

  // The "configure model" entry (agent panel button, translation-discard
  // confirmation) now switches to the models category in place — the embedded
  // panel lives here, so the dialog never closes to jump to the workspace.
  const openModelsCategory = () => {
    if (hasUnsavedTranslationDraft) {
      resetConfirmClosing();
      setPendingConfirmation("discard-translation-changes-and-open-models");
      return;
    }
    selectCategory("models");
  };

  const openConnectionsCategory = () => {
    selectCategory("connections");
  };

  useEffect(() => {
    // Our own save echoes straight back through this prop. Adopting it would
    // rebuild every field from the server snapshot, discarding whatever the user
    // has typed since the save started (translation endpoint, reply templates).
    // A change made anywhere else carries a different updatedAt and is adopted.
    if (settings.updatedAt && settings.updatedAt === lastPublishedSettingsAtRef.current) return;
    setCurrentSettings(settings);
  }, [settings]);

  useEffect(() => {
    setIntensityDraft(currentSettings.backgroundIntensity);
  }, [currentSettings.backgroundIntensity]);

  useEffect(() => {
    if (demoMode) {
      setExternalPairings([]);
      setExternalPairingsError(null);
      return undefined;
    }
    let active = true;
    setExternalPairingsError(null);
    api.agentPairings().then(({ pairings }) => {
      if (active) setExternalPairings(pairings);
    }).catch((error: unknown) => {
      if (active) {
        setExternalPairings(null);
        setExternalPairingsError(error);
      }
    });
    return () => {
      active = false;
    };
  }, [demoMode, externalPairingsReload]);

  useEffect(() => {
    if (demoMode) {
      setTranslationConfigurationLoading(false);
      setTranslationConfiguration(null);
      setTranslationConfigurationError(null);
      return undefined;
    }
    let active = true;
    setTranslationConfigurationLoading(true);
    setTranslationConfigurationError(null);
    void api.translationConfiguration().then((configuration) => {
      if (!active) return;
      setTranslationConfiguration(configuration);
      setTranslationEndpoint(configuration.endpoint);
      setTranslationApiKey("");
      setTranslationApiKeyVisible(false);
      setTranslationTimeoutMs(configuration.timeoutMs);
      setTranslationPrimary(configuration.primary ?? "google");
      setTranslationBackup(configuration.backup ?? "mymemory");
    }).catch((error: unknown) => {
      if (!active) return;
      setTranslationConfiguration(null);
      setTranslationConfigurationError(error);
    }).finally(() => {
      if (active) setTranslationConfigurationLoading(false);
    });
    return () => {
      active = false;
    };
    // Do not overwrite an unsaved service address, API key, or timeout when
    // the user changes the interface language while this dialog remains open.
  }, [demoMode, translationConfigurationLoadAttempt]);

  useEffect(() => {
    setLocale(activeLocale);
  }, [activeLocale, setLocale]);

  useEffect(() => {
    if (!isDesktopRuntime) return undefined;
    const bridge = desktopBridge();
    if (!bridge) return undefined;
    let active = true;
    let receivedUpdateEvent = false;
    void bridge.getUpdateStatus().then((snapshot) => {
      // A broadcast received after subscribing is newer than this initial read.
      if (active && !receivedUpdateEvent && snapshot) setUpdateStatus(snapshot);
    }).catch(() => undefined);
    const removeListener = bridge.onUpdateStatus((snapshot) => {
      receivedUpdateEvent = true;
      updateEventSeqRef.current += 1;
      if (active) setUpdateStatus(snapshot);
    });
    return () => {
      active = false;
      removeListener();
    };
  }, []);

  useLayoutEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
      // The select owns Escape while its listbox is expanded. This listener is
      // capture-phase so without the guard it would close the whole dialog
      // before the combobox has a chance to close only its own menu. The
      // active element fallback covers retargeted key events.
      if (expandedThemedSelectOwnsEscape(target, activeElement)) return;
      if (searchInputRef.current && (target === searchInputRef.current || activeElement === searchInputRef.current) && searchQuery) return;
      // The models form dialog, connections dialog or filter rules modal owns Escape while it is up. Yield before stopping the
      // event, otherwise the inner layer never sees it and this dialog would
      // close underneath the form.
      if (modelsOverlayOpen || filtersOverlayOpen || connectionsOverlayOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (controlsBusy) return;
      if (backgroundUploadError) {
        requestAlertClose();
        return;
      }
      if (pendingConfirmation) {
        requestConfirmClose();
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [backgroundUploadError, connectionsOverlayOpen, controlsBusy, filtersOverlayOpen, modelsOverlayOpen, pendingConfirmation, requestClose, requestConfirmClose, requestAlertClose, searchQuery]);

  useDialogFocus(true, settingsDialog, { fallbackFocusRef, suspended: Boolean(pendingConfirmation || backgroundUploadError || autoReplyDialogOpen || autoReplyDecisionsOpen || memoryDialogOpen || modelsOverlayOpen || filtersOverlayOpen || connectionsOverlayOpen) });
  useDialogFocus(Boolean(pendingConfirmation), confirmationDialog, { fallbackFocusRef: settingsDialog });
  useDialogFocus(Boolean(backgroundUploadError), backgroundAlert, { restoreFocusRef: uploadButton });

  const publishSettings = async (next: AppSettings): Promise<AppSettings> => {
    lastPublishedSettingsAtRef.current = next.updatedAt ?? null;
    setCurrentSettings(next);
    await onSettingsChange(next);
    return next;
  };

  /** Sequence number of the newest settings write; older ones must not publish. */
  const settingsWriteRef = useRef(0);
  /** `updatedAt` of the last snapshot this modal published (see the echo guard). */
  const lastPublishedSettingsAtRef = useRef<string | null>(null);

  /**
   * Optimistic settings update: applies the patch to local state immediately
   * (so the UI reacts instantly), then syncs to the server in the background.
   * If the server request fails, the previous settings are restored.
   *
   * This avoids the "pessimistic lock" pattern where `busyAction` disables all
   * controls while waiting for the API response, which caused visible UI lag
   * on theme switches and other reversible settings. Because saves are not
   * serialized, the newest write owns the state (see settingsWriteRef).
   */
  const applyOptimisticSettings = async (
    patch: AppSettingsPatch,
    successMessage: string | null,
  ): Promise<AppSettings | undefined> => {
    const previousSettings = currentSettings;
    const optimisticNext: AppSettings = {
      ...currentSettings,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    // Two saves issued back to back (theme, then density) can resolve out of
    // order, and the older response — or its rollback — would then put an older
    // snapshot on top of the newer one: the option the user just picked snaps
    // back, and sometimes stays back. Only the newest write may publish.
    const writeId = ++settingsWriteRef.current;
    const newestWrite = () => settingsWriteRef.current === writeId;
    const publish = async (next: AppSettings) => {
      if (!newestWrite()) return;
      lastPublishedSettingsAtRef.current = next.updatedAt ?? null;
      setCurrentSettings(next);
      await onSettingsChange(next);
    };
    // Apply immediately — UI reacts before the API round-trip. This one is
    // unconditional: it is the newest intent at this instant.
    lastPublishedSettingsAtRef.current = optimisticNext.updatedAt ?? null;
    setCurrentSettings(optimisticNext);
    try {
      await onSettingsChange(optimisticNext);
    } catch {
      // If the host rejects the change, roll back.
      await publish(previousSettings);
      return undefined;
    }
    try {
      const serverNext = demoMode
        ? optimisticNext
        : await api.updateSettings(patch);
      // If the server returned a different result (e.g. normalised values),
      // reconcile local state without flickering.
      if (serverNext !== optimisticNext) {
        await publish(serverNext);
      }
      // Most settings take effect visually the moment they are changed, so a
      // success banner is noise; only surface messages that carry information
      // (demo session-scoped saves, submit-style saves).
      if (successMessage) {
        // Demo mode appends the session-only caveat so the user knows the
        // change will not survive a restart.
        setNotice({
          kind: "success",
          message: demoMode ? t("settings.demo.resetAfterSession", { message: successMessage }) : successMessage,
        });
      }
      return serverNext;
    } catch (error) {
      // Roll back on failure — again only if this is still the newest write, so
      // a stale failure cannot undo a newer successful save or nag about it.
      await publish(previousSettings);
      if (newestWrite()) setNotice({ kind: "error", message: errorMessage(error, t("settings.error.save"), t) });
      return undefined;
    }
  };

  /**
   * Applies an access-level change. Switching to full-access first shows a
   * warning dialog; only after the user confirms is the patch applied.
   */
  const requestAccessLevelChange = (patch: AppSettingsPatch, value: AgentAccessLevel, successMessage: string | null) => {
    if (value === "full-access") {
      setPendingFullAccess({ patch, successMessage });
      resetConfirmClosing();
      setPendingConfirmation("enable-full-access");
      return;
    }
    void applyOptimisticSettings(patch, successMessage);
  };

  const changeLocale = (nextLocale: string) => {
    if (nextLocale === currentSettings.locale || busyAction) return;
    void applyOptimisticSettings({ locale: nextLocale }, null);
  };

  const choosePreset = (preset: Exclude<BackgroundPreset, "custom">) => {
    void applyOptimisticSettings({ backgroundPreset: preset }, null);
  };

  const commitIntensity = () => {
    if (intensityDraft === currentSettings.backgroundIntensity || busyAction) return;
    void applyOptimisticSettings({ backgroundIntensity: intensityDraft }, null);
  };

  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busyAction) return;
    const contentType = backgroundContentTypeForFile(file);
    if (!contentType) {
      resetAlertClosing();
      setBackgroundUploadError(t("settings.background.unsupportedFile", { filename: file.name }));
      return;
    }
    if (file.size > maxBackgroundUploadBytes) {
      resetAlertClosing();
      setBackgroundUploadError(t("settings.background.fileTooLarge", { filename: file.name }));
      return;
    }

    setBusyAction("background-upload");
    setNotice(null);
    let demoObjectUrl: string | null = null;
    let saved = false;
    try {
      const next = demoMode
        ? (() => {
          demoObjectUrl = URL.createObjectURL(file);
          return {
          ...currentSettings,
          backgroundPreset: "custom" as const,
          customBackgroundUrl: demoObjectUrl,
          updatedAt: new Date().toISOString(),
          };
        })()
        : await api.uploadBackground(file, contentType);
      await publishSettings(next);
      saved = true;
      if (demoMode) revokeDemoObjectUrl(currentSettings.customBackgroundUrl);
      setNotice({
        kind: "success",
        message: demoMode ? t("settings.background.customDemo") : t("settings.background.customSaved"),
      });
    } catch (error) {
      if (demoObjectUrl && !saved) revokeDemoObjectUrl(demoObjectUrl);
      resetAlertClosing();
      setBackgroundUploadError(errorMessage(error, t("settings.error.saveCustomBackground"), t));
    } finally {
      setBusyAction(null);
    }
  };

  const chooseCustomBackground = () => {
    if (currentSettings.customBackgroundUrl) {
      void applyOptimisticSettings({ backgroundPreset: "custom" }, null);
      return;
    }
    uploadInput.current?.click();
  };

  const clearCustomBackground = async () => {
    if (!currentSettings.customBackgroundUrl || busyAction) return;
    setBusyAction("background-remove");
    setNotice(null);
    const demoObjectUrl = demoMode ? currentSettings.customBackgroundUrl : null;
    try {
      const next = demoMode
        ? {
          ...currentSettings,
          backgroundPreset: "coast" as const,
          customBackgroundUrl: null,
          updatedAt: new Date().toISOString(),
        }
        : await api.removeBackground();
      await publishSettings(next);
      if (demoObjectUrl) revokeDemoObjectUrl(demoObjectUrl);
      setNotice({ kind: "success", message: demoMode ? t("settings.background.demoCleared") : t("settings.background.customDeleted") });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.deleteCustomBackground"), t) });
    } finally {
      setBusyAction(null);
    }
  };

  const notifyInBrowser = async (silent = currentSettings.notificationSound === "none") => {
    const bridge = desktopBridge();
    if (bridge) {
      await bridge.notify({
        title: t("app.name"),
        body: t("settings.notifications.testBody"),
        silent,
      });
      return;
    }
    if (isDesktopRuntime) throw new Error(t("settings.error.desktopNotificationsUnavailable"));
    if (!("Notification" in window)) throw new Error(t("settings.error.browserNotificationsUnsupported"));
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("settings.error.notificationsPermission"));
    new Notification(t("app.name"), { body: t("settings.notifications.testBody"), silent });
  };

  const playSoundTest = async () => {
    if (currentSettings.notificationSound === "none") {
      setNotice({ kind: "success", message: t("settings.sound.silentTest") });
      return;
    }
    if (currentSettings.notificationSound === "system") {
      await notifyInBrowser(false);
      return;
    }
    if (onTestSound) {
      await onTestSound(currentSettings.notificationSound);
      return;
    }
    const primed = await primeNotificationSound();
    if (primed && playNotificationSound(currentSettings.notificationSound)) return;
    await notifyInBrowser(false);
  };

  const testNotification = async () => {
    if (busyAction) return;
    setBusyAction("notification-test");
    setNotice(null);
    try {
      if (onTestNotification) {
        // The App-level test runs the FULL pipeline (banner plus the main-
        // process custom sound on desktop), so nothing extra to play here.
        await onTestNotification(currentSettings);
      } else {
        const customSound = currentSettings.notificationSound === "soft" || currentSettings.notificationSound === "bright";
        if (customSound) {
          const primed = await primeNotificationSound();
          const audible = primed && playNotificationSound(currentSettings.notificationSound);
          await notifyInBrowser(!audible);
          if (!audible) {
            // The prime failed (e.g. blocked audio device): the banner above
            // already fell back to the audible default — no extra tone.
            return;
          }
        } else {
          await notifyInBrowser(currentSettings.notificationSound === "none");
        }
      }
      setNotice({ kind: "success", message: t("settings.notifications.testSent") });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.sendTestNotification"), t) });
    } finally {
      setBusyAction(null);
    }
  };

  const testSound = async () => {
    if (busyAction) return;
    setBusyAction("sound-test");
    setNotice(null);
    try {
      await playSoundTest();
      if (currentSettings.notificationSound === "system") setNotice({ kind: "success", message: t("settings.sound.systemTestSent") });
      else if (currentSettings.notificationSound !== "none") setNotice({ kind: "success", message: t("settings.sound.testPlayed") });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.playSound"), t) });
    } finally {
      setBusyAction(null);
    }
  };

  const runUpdateAction = async (
    action: "check" | "download" | "skip" | "snooze",
    operation: () => Promise<DesktopUpdateSnapshot | undefined>,
  ) => {
    if (updateActionBusy) return;
    setUpdateActionBusy(action);
    setNotice(null);
    // The operation's own snapshot predates any progress event broadcast while
    // it ran; only apply it when nothing newer arrived meanwhile.
    const seqAtStart = updateEventSeqRef.current;
    try {
      const next = await operation();
      if (next && updateEventSeqRef.current === seqAtStart) setUpdateStatus(next);
    } catch (error) {
      setNotice({ kind: "error", message: updateBridgeErrorMessage(error, t("settings.error.updateAction"), t) });
    } finally {
      setUpdateActionBusy(null);
    }
  };

  const checkForUpdates = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: t("settings.error.autoUpdateUnavailable") });
      return;
    }
    void runUpdateAction("check", () => bridge.checkForUpdates());
  };

  const downloadUpdate = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: t("settings.error.autoUpdateUnavailable") });
      return;
    }
    void runUpdateAction("download", () => bridge.downloadUpdate());
  };

  const skipUpdate = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: t("settings.error.autoUpdateUnavailable") });
      return;
    }
    void runUpdateAction("skip", () => bridge.skipUpdate());
  };

  const snoozeUpdate = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: t("settings.error.autoUpdateUnavailable") });
      return;
    }
    void runUpdateAction("snooze", () => bridge.snoozeUpdate(updateSnoozeMinutes));
  };

  const installUpdate = async () => {
    if (updateActionBusy) return;
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: t("settings.error.autoUpdateUnavailable") });
      return;
    }
    setPendingConfirmation(null);
    setUpdateActionBusy("install");
    const seqAtStart = updateEventSeqRef.current;
    try {
      const result = await bridge.installUpdate();
      if (!result.accepted) {
        if (result.snapshot) {
          if (updateEventSeqRef.current === seqAtStart) setUpdateStatus(result.snapshot);
        } else {
          setNotice({ kind: "error", message: t("settings.error.updateNotReady") });
        }
      }
    } catch (error) {
      setNotice({ kind: "error", message: updateBridgeErrorMessage(error, t("settings.error.startUpdate"), t) });
    } finally {
      setUpdateActionBusy(null);
    }
  };

  const applyTranslationConfiguration = async (
    configuration: TranslationConfiguration,
    successMessage: string,
    preserveServiceDraft = false,
  ) => {
    setTranslationConfiguration(configuration);
    if (!preserveServiceDraft) {
      setTranslationEndpoint(configuration.endpoint);
      setTranslationTimeoutMs(configuration.timeoutMs);
    }
    setTranslationApiKey("");
    setTranslationApiKeyVisible(false);
    await onTranslationConfigurationChanged?.();
    setNotice({ kind: "success", message: successMessage });
  };

  const retryTranslationConfigurationLoad = () => {
    if (translationConfigurationLoading || controlsBusy) return;
    setTranslationConfigurationLoadAttempt((attempt) => attempt + 1);
  };

  const saveTranslationConfiguration = async () => {
    if (busyAction || !translationConfiguration) return;
    const endpoint = translationEndpoint.trim();
    if (!endpoint) {
      setNotice({ kind: "error", message: t("settings.translation.endpointRequired") });
      return;
    }
    setBusyAction("translation-configuration");
    setNotice(null);
    try {
      const timeoutMs = Number(translationTimeoutMs);
      const next = await api.updateTranslationConfiguration({
        endpoint,
        timeoutMs,
        primary: translationPrimary,
        backup: translationBackup,
        ...(translationApiKey.trim() ? { apiKey: translationApiKey } : {}),
      });
      await applyTranslationConfiguration(next, t("settings.translation.saved"));
    } catch (error) {
      setNotice({ kind: "error", message: translationConfigurationErrorMessage(error, t) });
    } finally {
      setBusyAction(null);
    }
  };

  const removeTranslationConfiguration = async () => {
    if (busyAction || !translationConfiguration) return;
    setBusyAction("translation-configuration-remove");
    setNotice(null);
    try {
      const next = await api.removeTranslationConfiguration();
      await applyTranslationConfiguration(next, t("settings.translation.removed"));
    } catch (error) {
      setNotice({ kind: "error", message: translationConfigurationErrorMessage(error, t) });
    } finally {
      setBusyAction(null);
    }
  };

  const removeTranslationApiKey = async () => {
    if (busyAction || !translationConfiguration) return;
    setBusyAction("translation-configuration-remove-key");
    setNotice(null);
    try {
      const next = await api.updateTranslationConfiguration({ clearApiKey: true });
      await applyTranslationConfiguration(next, t("settings.translation.keyRemoved"), true);
    } catch (error) {
      setNotice({ kind: "error", message: translationConfigurationErrorMessage(error, t) });
    } finally {
      setBusyAction(null);
    }
  };

  const restoreDefaults = async () => {
    if (busyAction) return;
    setBusyAction("restore-defaults");
    setNotice(null);
    const demoObjectUrl = demoMode ? currentSettings.customBackgroundUrl : null;
    try {
      if (demoMode) {
        await publishSettings({
          ...currentSettings,
          ...restoreDefaultsPatch,
          customBackgroundUrl: null,
          updatedAt: new Date().toISOString(),
        });
      } else {
        if (currentSettings.customBackgroundUrl) {
          const withoutBackground = await api.removeBackground();
          await publishSettings(withoutBackground);
        }
        const next = await api.updateSettings(restoreDefaultsPatch);
        await publishSettings(next);
      }
      if (demoObjectUrl) revokeDemoObjectUrl(demoObjectUrl);
      setNotice({ kind: "success", message: demoMode ? t("settings.defaults.appliedToDemo") : t("settings.defaults.restored") });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.restoreDefaults"), t) });
    } finally {
      setBusyAction(null);
    }
  };

  const hasCustomBackground = Boolean(currentSettings.customBackgroundUrl);

  const translationConfigurationNeedsReplacementKey = Boolean(
    translationConfiguration?.source === "environment"
    && translationConfiguration.apiKeyConfigured
    && !translationApiKey.trim(),
  );
  const translationApiKeyHint = translationConfiguration?.configurationError
    ? t("settings.translation.apiKeyRecoveryHint")
    : translationConfiguration?.source === "environment" && translationConfiguration.apiKeyConfigured
      ? t("settings.translation.apiKeyEnvironmentHint")
      : translationConfiguration?.apiKeyConfigured
        ? t("settings.translation.apiKeyHint")
        : t("settings.translation.apiKeyOptionalHint");
  const updateControlsBusy = controlsBusy || Boolean(updateActionBusy);
  const confirmationTitle = pendingConfirmation === "clear-background"
    ? t("settings.confirmation.clearBackgroundTitle")
    : pendingConfirmation === "install-update"
      ? t("settings.confirmation.installUpdateTitle")
      : pendingConfirmation === "remove-translation-configuration"
        ? t("settings.confirmation.removeTranslationServiceTitle")
        : pendingConfirmation === "remove-translation-api-key"
          ? t("settings.confirmation.removeTranslationApiKeyTitle")
          : pendingTranslationDiscard
            ? t("settings.confirmation.discardTranslationChangesTitle")
            : t("settings.confirmation.restoreDefaultsTitle");
  const confirmationDescription = pendingConfirmation === "clear-background"
    ? t("settings.confirmation.clearBackgroundDescription")
    : pendingConfirmation === "install-update"
      ? t("settings.confirmation.installUpdateDescription")
      : pendingConfirmation === "remove-translation-configuration"
        ? t("settings.confirmation.removeTranslationServiceDescription")
        : pendingConfirmation === "remove-translation-api-key"
          ? t("settings.confirmation.removeTranslationApiKeyDescription")
          : pendingTranslationDiscard
            ? t("settings.confirmation.discardTranslationChangesDescription")
            : t("settings.confirmation.restoreDefaultsDescription");
  const confirmationAction = pendingConfirmation === "clear-background"
    ? t("settings.confirmation.clearBackgroundAction")
    : pendingConfirmation === "install-update"
      ? t("settings.update.restartAndUpdate")
      : pendingConfirmation === "remove-translation-configuration"
        ? t("settings.confirmation.removeTranslationServiceAction")
        : pendingConfirmation === "remove-translation-api-key"
          ? t("settings.confirmation.removeTranslationApiKeyAction")
          : pendingConfirmation === "enable-full-access"
            ? t("settings.agent.fullAccessWarningAction")
            : pendingConfirmation === "discard-translation-changes-and-open-models"
            ? t("settings.confirmation.discardTranslationChangesAndOpenModelsAction")
            : pendingConfirmation === "discard-translation-changes"
            ? t("settings.confirmation.discardTranslationChangesAction")
            : t("settings.confirmation.restoreDefaultsAction");
  const selectCategory = (next: SettingsCategoryId) => {
    if (next === activeCategory) return;
    setActiveCategory(next);
    // A category switch is a fresh browsing context: entering it starts at the
    // top instead of carrying over the previous panel's scroll offset. Direct
    // scrollTop assignment keeps the reset instant (and testable in jsdom).
    if (settingsBody.current) settingsBody.current.scrollTop = 0;
  };

  const searchResults = useMemo(() => searchSettings(searchQuery, t, isDesktopRuntime), [searchQuery, t]);

  useEffect(() => {
    if (searchResults && searchResults.length > 0) {
      if (!searchResults.some((r) => r.categoryId === activeCategory)) {
        selectCategory(searchResults[0].categoryId);
      }
    }
  }, [searchResults, activeCategory]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigateToTarget = (categoryId: SettingsCategoryId, targetId?: string) => {
    selectCategory(categoryId);
    if (targetId) {
      requestAnimationFrame(() => {
        const el = document.getElementById(targetId) || document.querySelector(targetId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }
  };

  // The record keys are the full category set, so TypeScript rejects a nav
  // entry whose panel is missing (the old scroll-nav could point at nothing).
  const panels: Record<SettingsCategoryId, ReactNode> = {
    language: (
      <SettingsLanguagePanel
        t={t}
        locales={locales}
        activeLocale={activeLocale}
        controlsBusy={controlsBusy}
        changeLocale={changeLocale}
      />
    ),
    appearance: (
      <SettingsAppearanceSection
        t={t}
        currentSettings={currentSettings}
        controlsBusy={controlsBusy}
        busyAction={busyAction}
        demoMode={demoMode}
        intensityDraft={intensityDraft}
        hasCustomBackground={hasCustomBackground}
        applyOptimisticSettings={applyOptimisticSettings}
        choosePreset={choosePreset}
        setIntensityDraft={setIntensityDraft}
        commitIntensity={commitIntensity}
        chooseCustomBackground={chooseCustomBackground}
        uploadBackground={uploadBackground}
        resetConfirmClosing={resetConfirmClosing}
        setPendingConfirmation={setPendingConfirmation}
        uploadButtonRef={uploadButton}
      />
    ),
    notifications: (
      <SettingsNotificationsPanel
        t={t}
        currentSettings={currentSettings}
        controlsBusy={controlsBusy}
        busyAction={busyAction}
        applyOptimisticSettings={applyOptimisticSettings}
        testNotification={testNotification}
        testSound={testSound}
      />
    ),
    desktop: (
      <SettingsDesktopPanel
        t={t}
        currentSettings={currentSettings}
        controlsBusy={controlsBusy}
        updateControlsBusy={updateControlsBusy}
        updateStatus={updateStatus}
        updatePresentation={updatePresentation}
        updateActionBusy={updateActionBusy}
        updateSnoozeMinutes={updateSnoozeMinutes}
        setUpdateSnoozeMinutes={setUpdateSnoozeMinutes}
        checkForUpdates={checkForUpdates}
        downloadUpdate={downloadUpdate}
        skipUpdate={skipUpdate}
        snoozeUpdate={snoozeUpdate}
        applyOptimisticSettings={applyOptimisticSettings}
        resetConfirmClosing={resetConfirmClosing}
        setPendingConfirmation={setPendingConfirmation}
      />
    ),
    sync: (
      <SettingsSyncPanel
        t={t}
        currentSettings={currentSettings}
        controlsBusy={controlsBusy}
        applyOptimisticSettings={applyOptimisticSettings}
      />
    ),
    filters: (
      <FilterRulesSection
        accounts={accounts}
        demoMode={demoMode}
        overlayHostRef={settingsBackdrop}
        onOverlayOpenChange={setFiltersOverlayOpen}
      />
    ),
    models: (
      <SettingsModelsSection
        view="providers"
        t={t}
        demoMode={demoMode}
        initialProviders={agentProviderSeed?.providers ?? []}
        initialDefaultProviderId={agentProviderSeed?.defaultProviderId ?? null}
        onProvidersChanged={(providers) => onAgentProviderListChanged?.(providers)}
        onOverlayOpenChange={setModelsOverlayOpen}
        onBusyChange={setModelsBusy}
        overlayHostRef={settingsBackdrop}
      />
    ),
    mcp: (
      <SettingsModelsSection
        view="mcp"
        t={t}
        demoMode={demoMode}
        initialProviders={agentProviderSeed?.providers ?? []}
        initialDefaultProviderId={agentProviderSeed?.defaultProviderId ?? null}
        onProvidersChanged={(providers) => onAgentProviderListChanged?.(providers)}
        onOverlayOpenChange={setModelsOverlayOpen}
        onBusyChange={setModelsBusy}
        overlayHostRef={settingsBackdrop}
      />
    ),
    connections: (
      <SettingsConnectionsSection
        t={t}
        formatDate={formatDate}
        accounts={accounts}
        currentSettings={currentSettings}
        controlsBusy={controlsBusy}
        demoMode={demoMode}
        applyOptimisticSettings={applyOptimisticSettings}
        requestAccessLevelChange={requestAccessLevelChange}
        onOverlayOpenChange={setConnectionsOverlayOpen}
        onBusyChange={setConnectionsBusy}
        overlayHostRef={settingsBackdrop}
      />
    ),
    agent: (
      <SettingsAgentSection
        t={t}
        formatDate={formatDate}
        accounts={accounts}
        currentSettings={currentSettings}
        controlsBusy={controlsBusy}
        demoMode={demoMode}
        openModelSettings={openModelsCategory}
        openConnectionsSettings={openConnectionsCategory}
        requestAccessLevelChange={requestAccessLevelChange}
        applyOptimisticSettings={applyOptimisticSettings}
        externalGuideCopied={externalGuideCopied}
        setExternalGuideCopied={setExternalGuideCopied}
        externalPairings={externalPairings}
        externalPairingsError={externalPairingsError}
        setExternalPairingsReload={setExternalPairingsReload}
        setAutoReplyDialogOpen={setAutoReplyDialogOpen}
        setAutoReplyDecisionsOpen={setAutoReplyDecisionsOpen}
        setMemoryDialogOpen={setMemoryDialogOpen}
        overlayHostRef={settingsBackdrop}
      />
    ),
    translation: (
      <SettingsTranslationSection
        t={t}
        controlsBusy={controlsBusy}
        busyAction={busyAction}
        demoMode={demoMode}
        translationConfiguration={translationConfiguration}
        translationConfigurationLoading={translationConfigurationLoading}
        translationConfigurationError={translationConfigurationError}
        translationEndpoint={translationEndpoint}
        setTranslationEndpoint={setTranslationEndpoint}
        translationApiKey={translationApiKey}
        setTranslationApiKey={setTranslationApiKey}
        translationApiKeyVisible={translationApiKeyVisible}
        setTranslationApiKeyVisible={setTranslationApiKeyVisible}
        translationTimeoutMs={translationTimeoutMs}
        setTranslationTimeoutMs={setTranslationTimeoutMs}
        translationPrimary={translationPrimary}
        setTranslationPrimary={setTranslationPrimary}
        translationBackup={translationBackup}
        setTranslationBackup={setTranslationBackup}
        translationConfigurationNeedsReplacementKey={translationConfigurationNeedsReplacementKey}
        translationApiKeyHint={translationApiKeyHint}
        saveTranslationConfiguration={saveTranslationConfiguration}
        retryTranslationConfigurationLoad={retryTranslationConfigurationLoad}
        resetConfirmClosing={resetConfirmClosing}
        setPendingConfirmation={setPendingConfirmation}
      />
    ),
  };

  return (
    <div ref={settingsBackdrop} className={`modal-backdrop settings-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section ref={settingsDialog} className={`modal-card settings-modal${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <header className="modal-heading settings-heading">
          <h2 id="settings-title">{t("settings.title")}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label={t("common.close")}
            disabled={closeBlocked}
            data-tooltip={closeBlockedHint ?? t("common.close")}
            onClick={requestClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("settings.nav.title")}>
            <div className="settings-nav-search">
              <Search size={13} className="settings-nav-search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                className="settings-nav-search-input"
                placeholder={t("settings.search.placeholder")}
                aria-label={t("settings.search.placeholder")}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) {
                    event.stopPropagation();
                    setSearchQuery("");
                  } else if (event.key === "Enter" && searchResults && searchResults.length > 0) {
                    selectCategory(searchResults[0].categoryId);
                  }
                }}
                spellCheck={false}
                autoComplete="off"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="settings-nav-search-clear"
                  aria-label={t("settings.search.clear")}
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {searchResults !== null ? (
              searchResults.length === 0 ? (
                <div className="settings-nav-search-empty" role="status">
                  <SearchX size={20} />
                  <span>{t("settings.search.noResults")}</span>
                </div>
              ) : (
                <div className="settings-nav-group">
                  <p className="settings-nav-group-label">
                    {t("settings.search.resultsTitle")} ({searchResults.length})
                  </p>
                  {searchResults.map((result) => {
                    const id = result.categoryId;
                    const meta = categoryMeta[id];
                    const active = activeCategory === id;
                    return (
                      <div key={id} className="settings-search-result-group">
                        <button
                          key={id}
                          type="button"
                          id={`settings-nav-${id}`}
                          className={`settings-nav-item${active ? " active" : ""}`}
                          aria-current={active ? "true" : undefined}
                          onClick={() => selectCategory(id)}
                        >
                          <meta.icon size={14} />
                          <span>{t(meta.labelKey)}</span>
                        </button>
                        {result.matchedItems.length > 0 && (
                          <div className="settings-search-match-tags">
                            {result.matchedItems.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className="settings-search-match-tag"
                                onClick={() => navigateToTarget(id, item.targetId)}
                              >
                                {item.title}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )
            ) : (
              visibleNavGroups.map((group) => (
                <div className="settings-nav-group" key={group.key}>
                  <p className="settings-nav-group-label">{t(settingsNavGroupLabelKeys[group.key])}</p>
                  {group.items.map((id) => {
                    const meta = categoryMeta[id];
                    const active = activeCategory === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        id={`settings-nav-${id}`}
                        className={`settings-nav-item${active ? " active" : ""}`}
                        aria-current={active ? "true" : undefined}
                        onClick={() => selectCategory(id)}
                      >
                        <meta.icon size={14} />{t(meta.labelKey)}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </nav>
          <div className="settings-body" ref={settingsBody}>
            <FormNotice notice={notice} onDismiss={() => setNotice(null)} />
            <div
              className="settings-panel"
              key={activeCategory}
              // A nav + region pair, not a tablist: the sidebar is a list of
              // links with aria-current, so the panel must not claim to be the
              // tab half of a tab pattern it does not implement.
              role="region"
              id="settings-active-panel"
              aria-labelledby={`settings-nav-${activeCategory}`}
            >
              {panels[activeCategory]}
            </div>
          </div>
        </div>

        <footer className="settings-footer">
          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("restore-defaults"); }}>
            {busyAction === "restore-defaults" ? <LoaderCircle className="spin" size={15} /> : <Undo2 size={15} />}{t("settings.defaults.restore")}
          </button>
          <button className="primary-button" type="button" disabled={closeBlocked} data-tooltip={closeBlockedHint ?? undefined} onClick={requestClose}>{t("settings.done")}</button>
        </footer>
      </section>
      {pendingConfirmation && (
        <div className={`modal-backdrop confirmation-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestConfirmClose()}>
          <section ref={confirmationDialog} className={`confirmation-card${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="settings-confirmation-title" aria-describedby="settings-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            <h3 id="settings-confirmation-title">{confirmationTitle}</h3>
            <p id="settings-confirmation-description">{confirmationDescription}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={controlsBusy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
              <button
                className={pendingConfirmation === "install-update" ? "primary-button" : "secondary-button danger-button"}
                type="button"
                disabled={controlsBusy}
                onClick={() => {
                  const action = pendingConfirmation;
                  setPendingConfirmation(null);
                  setPendingFullAccess(null);
                  if (action === "clear-background") void clearCustomBackground();
                  else if (action === "install-update") void installUpdate();
                  else if (action === "remove-translation-configuration") void removeTranslationConfiguration();
                  else if (action === "remove-translation-api-key") void removeTranslationApiKey();
                  else if (action === "discard-translation-changes-and-open-models") selectCategory("models");
                  else if (action === "discard-translation-changes") onClose();
                  else if (action === "enable-full-access" && pendingFullAccess) void applyOptimisticSettings(pendingFullAccess.patch, pendingFullAccess.successMessage);
                  else void restoreDefaults();
                }}
              >
                {pendingConfirmation === "install-update" ? <RotateCcw size={14} /> : pendingConfirmation === "remove-translation-configuration" ? <Trash2 size={14} /> : pendingConfirmation === "remove-translation-api-key" ? <KeyRound size={14} /> : pendingConfirmation === "enable-full-access" ? <Zap size={14} /> : pendingTranslationDiscard ? <X size={14} /> : null}
                {confirmationAction}
              </button>
            </div>
          </section>
        </div>
      )}
      {backgroundUploadError && (
        <div className={`modal-backdrop settings-alert-backdrop${alertClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestAlertClose()}>
          <section ref={backgroundAlert} className={`settings-alert-card${alertClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="background-upload-error-title" aria-describedby="background-upload-error-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.background.alertEyebrow")}</span>
            <h3 id="background-upload-error-title">{t("settings.background.alertTitle")}</h3>
            <p id="background-upload-error-description">{backgroundUploadError}</p>
            <div className="settings-alert-actions">
              <button className="primary-button" type="button" onClick={requestAlertClose}>{t("settings.background.alertDismiss")}</button>
            </div>
          </section>
        </div>
      )}
      {autoReplyDialogOpen && (
        <AutoReplyPendingDialog
          accounts={accounts}
          onClose={() => setAutoReplyDialogOpen(false)}
          fallbackFocusRef={settingsDialog}
        />
      )}
      {autoReplyDecisionsOpen && (
        <AutoReplyDecisionsDialog
          accounts={accounts}
          onClose={() => setAutoReplyDecisionsOpen(false)}
          fallbackFocusRef={settingsDialog}
        />
      )}
      {memoryDialogOpen && (
        <AgentMemoryDialog
          accounts={accounts}
          onClose={() => setMemoryDialogOpen(false)}
          fallbackFocusRef={settingsDialog}
        />
      )}
    </div>
  );
}
