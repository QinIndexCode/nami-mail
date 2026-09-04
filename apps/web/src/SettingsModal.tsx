import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import {
  Bell,
  Bot,
  Check,
  Clock3,
  Download,
  KeyRound,
  Laptop,
  Languages,
  LoaderCircle,
  Palette,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { api, type TranslationConfiguration, type TranslationProviderId } from "./api";
import type { ExternalPairingSummary } from "./agentTypes";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import { mailErrorMessage } from "./errorPresentation";
import FilterRulesSection from "./FilterRulesSection";
import AgentMemoryDialog from "./AgentMemoryDialog";
import AutoReplyPendingDialog from "./AutoReplyPendingDialog";
import AutoReplyDecisionsDialog from "./AutoReplyDecisionsDialog";
import { useI18n } from "./i18n";
import { canPlayCustomNotificationSound, playNotificationSound, primeNotificationSound } from "./sounds";
import ThemedSelect from "./ThemedSelect";
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
  AppTheme,
  BackgroundPreset,
  CloseBehavior,
  ListDensity,
  NotificationSound,
} from "./types";
import { defaultAppSettings } from "./types";
import {
  soundOptions,
  closeBehaviorOptions,
  errorMessage,
  backgroundContentTypeForFile,
  revokeDemoObjectUrl,
  copyGuideTextToClipboard,
  maxBackgroundUploadBytes,
} from "./settings/settings-utils";
import { Switch, CloseBehaviorIcon } from "./settings/SettingsUIComponents";
import SettingsAgentSection from "./settings/SettingsAgentSection";
import SettingsTranslationSection from "./settings/SettingsTranslationSection";
import SettingsAppearanceSection from "./settings/SettingsAppearanceSection";

const isDesktopRuntime = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("desktop") === "1";


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
  /** Opens the existing model-provider manager after this dialog has closed. */
  onOpenAgentProviderSettings: () => void;
  /** Visible control used only when the original trigger disappears, such as a closed mobile drawer. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Demo settings are intentionally in-memory and are never sent to the local API. */
  demoMode?: boolean;
};

type EscapeTarget = Pick<Element, "closest">;

export function expandedThemedSelectOwnsEscape(
  eventTarget: EscapeTarget | null,
  activeElement: EscapeTarget | null,
): boolean {
  const selectControl = eventTarget?.closest(".select-control")
    ?? activeElement?.closest(".select-control");
  return Boolean(selectControl?.querySelector('[role="combobox"][aria-expanded="true"]'));
}

type Notice = { kind: "success" | "error"; message: string } | null;
type PendingSettingsConfirmation =
  | "clear-background"
  | "restore-defaults"
  | "install-update"
  | "remove-translation-configuration"
  | "remove-translation-api-key"
  | "discard-translation-changes"
  | "discard-translation-changes-and-open-agent"
  | "enable-full-access";

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
};


export default function SettingsModal({
  settings,
  accounts,
  onClose,
  onSettingsChange,
  onTestNotification,
  onTestSound,
  onTranslationConfigurationChanged,
  onOpenAgentProviderSettings,
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
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);

  // Sidebar nav: keep the highlighted entry in sync with the section that is
  // currently at the top of the scrollable content column.
  useEffect(() => {
    const body = settingsBody.current;
    if (!body) return;
    const sections = Array.from(body.querySelectorAll<HTMLElement>("[data-settings-nav]"));
    if (sections.length === 0) return;
    const onScroll = () => {
      const marker = body.getBoundingClientRect().top + 1;
      let active: string | null = null;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= marker) active = section.dataset.settingsNav ?? null;
        else break;
      }
      // At the very bottom the last section may be too tall to align at the
      // top of the content column; treat it as active so the highlight
      // always lands on a real section.
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) {
        active = sections[sections.length - 1]?.dataset.settingsNav ?? null;
      }
      setActiveNavKey(active);
    };
    onScroll();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  const [externalPairingsReload, setExternalPairingsReload] = useState(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  const settingsBody = useRef<HTMLDivElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const backgroundAlert = useRef<HTMLElement>(null);
  const activeLocale = currentSettings.locale || locale;
  const controlsBusy = Boolean(busyAction || updateActionBusy === "install");
  const updatePresentation = updateStatus ? presentUpdateSnapshot(updateStatus, t) : null;
  const hasUnsavedTranslationDraft = hasUnsavedTranslationConfiguration(translationConfiguration, {
    endpoint: translationEndpoint,
    apiKey: translationApiKey,
    timeoutMs: translationTimeoutMs,
    primary: translationPrimary,
    backup: translationBackup,
  });
  const pendingTranslationDiscard = pendingConfirmation === "discard-translation-changes"
    || pendingConfirmation === "discard-translation-changes-and-open-agent";

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
    if (hasUnsavedTranslationDraft) {
      resetConfirmClosing();
      setPendingConfirmation("discard-translation-changes");
      return;
    }
    requestExit();
  }, [controlsBusy, hasUnsavedTranslationDraft, requestExit, resetConfirmClosing]);

  const requestAgentProviderSettings = () => {
    if (controlsBusy || demoMode) return;
    if (hasUnsavedTranslationDraft) {
      resetConfirmClosing();
      setPendingConfirmation("discard-translation-changes-and-open-agent");
      return;
    }
    onOpenAgentProviderSettings();
  };

  useEffect(() => {
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
    void bridge.getUpdateStatus().then((snapshot) => {
      if (active && snapshot) setUpdateStatus(snapshot);
    }).catch(() => undefined);
    const removeListener = bridge.onUpdateStatus((snapshot) => {
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
  }, [backgroundUploadError, controlsBusy, pendingConfirmation, requestClose, requestConfirmClose, requestAlertClose]);

  useDialogFocus(true, settingsDialog, { fallbackFocusRef, suspended: Boolean(pendingConfirmation || backgroundUploadError || autoReplyDialogOpen || autoReplyDecisionsOpen || memoryDialogOpen) });
  useDialogFocus(Boolean(pendingConfirmation), confirmationDialog, { fallbackFocusRef: settingsDialog });
  useDialogFocus(Boolean(backgroundUploadError), backgroundAlert, { restoreFocusRef: uploadButton });

  const publishSettings = async (next: AppSettings): Promise<AppSettings> => {
    setCurrentSettings(next);
    await onSettingsChange(next);
    return next;
  };

  /**
   * Optimistic settings update: applies the patch to local state immediately
   * (so the UI reacts instantly), then syncs to the server in the background.
   * If the server request fails, the previous settings are restored.
   *
   * This avoids the "pessimistic lock" pattern where `busyAction` disables all
   * controls while waiting for the API response, which caused visible UI lag
   * on theme switches and other reversible settings.
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
    // Apply immediately — UI reacts before the API round-trip.
    setCurrentSettings(optimisticNext);
    try {
      await onSettingsChange(optimisticNext);
    } catch {
      // If the host rejects the change, roll back.
      setCurrentSettings(previousSettings);
      return undefined;
    }
    try {
      const serverNext = demoMode
        ? optimisticNext
        : await api.updateSettings(patch);
      // If the server returned a different result (e.g. normalised values),
      // reconcile local state without flickering.
      if (serverNext !== optimisticNext) {
        setCurrentSettings(serverNext);
        await onSettingsChange(serverNext);
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
      // Roll back on failure.
      setCurrentSettings(previousSettings);
      await onSettingsChange(previousSettings);
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.save"), t) });
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
    const ready = await primeNotificationSound() && canPlayCustomNotificationSound();
    if (ready && playNotificationSound(currentSettings.notificationSound)) return;
    await notifyInBrowser(false);
  };

  const testNotification = async () => {
    if (busyAction) return;
    setBusyAction("notification-test");
    setNotice(null);
    try {
      const customSound = currentSettings.notificationSound === "soft" || currentSettings.notificationSound === "bright";
      if (onTestNotification) {
        await onTestNotification(currentSettings);
        if (customSound) {
          if (onTestSound) {
            await onTestSound(currentSettings.notificationSound);
          } else {
            const ready = await primeNotificationSound() && canPlayCustomNotificationSound();
            if (!ready || !playNotificationSound(currentSettings.notificationSound)) await notifyInBrowser(false);
          }
        }
      } else if (customSound) {
        const ready = await primeNotificationSound() && canPlayCustomNotificationSound();
        await notifyInBrowser(ready);
        if (ready && !playNotificationSound(currentSettings.notificationSound)) await notifyInBrowser(false);
      } else {
        await notifyInBrowser(currentSettings.notificationSound === "none");
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
    try {
      const next = await operation();
      if (next) setUpdateStatus(next);
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
    try {
      const result = await bridge.installUpdate();
      if (!result.accepted) {
        if (result.snapshot) {
          setUpdateStatus(result.snapshot);
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
  const copyExternalGuide = (text: string, id: string) => {
    void copyGuideTextToClipboard(text).then((copied) => {
      if (!copied) return;
      setExternalGuideCopied(id);
      window.setTimeout(() => {
        setExternalGuideCopied((current) => current === id ? null : current);
      }, 1_800);
    });
  };
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
            : pendingConfirmation === "discard-translation-changes-and-open-agent"
            ? t("settings.confirmation.discardTranslationChangesAndOpenAgentAction")
            : pendingConfirmation === "discard-translation-changes"
            ? t("settings.confirmation.discardTranslationChangesAction")
            : t("settings.confirmation.restoreDefaultsAction");
  const navItems: { key: string; icon: LucideIcon; label: string }[] = [
    { key: "language", icon: Languages, label: t("language.title") },
    { key: "appearance", icon: Palette, label: t("settings.appearance.title") },
    { key: "notifications", icon: Bell, label: t("settings.notifications.title") },
    ...(isDesktopRuntime ? [{ key: "desktop", icon: Laptop, label: t("settings.desktop.title") }] : []),
    { key: "sync", icon: RefreshCw, label: t("settings.sync.title") },
    { key: "agent", icon: Bot, label: t("agent.launch") },
    { key: "translation", icon: KeyRound, label: t("settings.translation.title") },
  ];
  const scrollToSection = (key: string) => {
    const body = settingsBody.current;
    if (!body) return;
    const section = body.querySelector<HTMLElement>(`[data-settings-nav="${key}"]`);
    if (!section) return;
    // Scroll only the content column. The header and the sidebar stay fixed
    // (the modal itself does not scroll), so no offset is needed and nothing
    // outside the dialog can shift.
    body.scrollTo({
      top: section.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop,
      behavior: "smooth",
    });
  };

  return (
    <div className={`modal-backdrop settings-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section ref={settingsDialog} className={`modal-card settings-modal${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <header className="modal-heading settings-heading">
          <div>
            <span className="eyebrow">{t("settings.eyebrow")}</span>
            <h2 id="settings-title">{t("settings.title")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.close")} data-tooltip={t("common.close")} onClick={requestClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("settings.nav.title")}>
            <p className="settings-nav-title">{t("settings.nav.title")}</p>
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`settings-nav-item${activeNavKey === item.key ? " active" : ""}`}
                aria-current={activeNavKey === item.key ? "true" : undefined}
                onClick={() => scrollToSection(item.key)}
              >
                <item.icon size={14} />{item.label}
              </button>
            ))}
          </nav>
          <div className="settings-body" ref={settingsBody}>
            {notice && <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}{notice.message}</div>}

            <section className="settings-section" data-settings-nav="language" aria-labelledby="language-settings">
              <div className="settings-section-title">
                <Languages size={16} />
                <div><span>{t("language.title")}</span><p id="language-settings">{t("language.description")}</p></div>
              </div>
              <label className="setting-select-row" htmlFor="interface-language">
                <span><strong>{t("language.label")}</strong><small>{t("settings.language.applyImmediately")}</small></span>
                <ThemedSelect
                  id="interface-language"
                  value={activeLocale}
                  aria-label={t("language.label")}
                  disabled={controlsBusy}
                  onValueChange={changeLocale}
                >
                  {locales.map((option) => <option key={option.locale} value={option.locale}>{option.nativeName}</option>)}
                </ThemedSelect>
              </label>
            </section>

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

            <section className="settings-section" data-settings-nav="notifications" aria-labelledby="notification-settings">
              <div className="settings-section-title">
                <Bell size={16} />
                <div><span>{t("settings.notifications.title")}</span><p id="notification-settings">{t("settings.notifications.description")}</p></div>
              </div>
              <Switch
                checked={currentSettings.notificationsEnabled}
                disabled={controlsBusy}
                label={t("settings.notifications.desktop.label")}
                description={t("settings.notifications.desktop.description")}
                onChange={() => void applyOptimisticSettings({ notificationsEnabled: !currentSettings.notificationsEnabled }, null)}
              />
              <Switch
                checked={currentSettings.notifyWhenFocused}
                disabled={controlsBusy || !currentSettings.notificationsEnabled}
                label={t("settings.notifications.focused.label")}
                description={t("settings.notifications.focused.description")}
                onChange={() => void applyOptimisticSettings({ notifyWhenFocused: !currentSettings.notifyWhenFocused }, null)}
              />

              <div className={`setting-subheading${currentSettings.notificationsEnabled ? "" : " muted"}`}><span>{t("settings.sound.title")}</span><small>{currentSettings.notificationsEnabled ? t("settings.sound.description") : t("settings.sound.enableNotificationsFirst")}</small></div>
              <div className="settings-option-grid sound-option-grid" role="group" aria-label={t("settings.sound.groupLabel")}>
                {soundOptions.map((option) => (
                  <button
                    key={option.value}
                    className={`settings-option sound-option${currentSettings.notificationSound === option.value ? " active" : ""}`}
                    type="button"
                    aria-pressed={currentSettings.notificationSound === option.value}
                    disabled={controlsBusy || !currentSettings.notificationsEnabled}
                    onClick={() => void applyOptimisticSettings({ notificationSound: option.value }, null)}
                  >
                    {option.value === "none" ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    <span><strong>{t(option.labelKey)}</strong><small>{t(option.detailKey)}</small></span>
                    {currentSettings.notificationSound === option.value && <Check className="option-check" size={15} />}
                  </button>
                ))}
              </div>
              <div className="settings-inline-actions">
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void testNotification()}>
                  {busyAction === "notification-test" ? <LoaderCircle className="spin" size={15} /> : <Bell size={15} />}{t("settings.notifications.test")}
                </button>
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void testSound()}>
                  {busyAction === "sound-test" ? <LoaderCircle className="spin" size={15} /> : <Volume2 size={15} />}{t("settings.sound.test")}
                </button>
              </div>
            </section>

            {isDesktopRuntime && (
              <section className="settings-section" data-settings-nav="desktop" aria-labelledby="desktop-settings">
                <div className="settings-section-title">
                  <Laptop size={16} />
                  <div><span>{t("settings.desktop.title")}</span><p id="desktop-settings">{t("settings.desktop.description")}</p></div>
                </div>
                <div className="settings-option-grid close-behavior-grid" role="group" aria-label={t("settings.closeBehavior.groupLabel")}>
                  {closeBehaviorOptions.map((option) => (
                    <button
                      key={option.value}
                      className={`settings-option${currentSettings.closeBehavior === option.value ? " active" : ""}`}
                      type="button"
                      data-close-behavior={option.value}
                      aria-pressed={currentSettings.closeBehavior === option.value}
                      disabled={controlsBusy}
                      onClick={() => void applyOptimisticSettings({ closeBehavior: option.value }, null)}
                    >
                      <CloseBehaviorIcon value={option.value} />
                      <span><strong>{t(option.labelKey)}</strong><small>{t(option.detailKey)}</small></span>
                      {currentSettings.closeBehavior === option.value && <Check className="option-check" size={15} />}
                    </button>
                  ))}
                </div>
                <Switch
                  checked={currentSettings.launchAtStartup}
                  disabled={controlsBusy}
                  label={t("settings.launchAtStartup.label")}
                  description={t("settings.launchAtStartup.description")}
                  onChange={() => void applyOptimisticSettings({ launchAtStartup: !currentSettings.launchAtStartup }, null)}
                />
                <Switch
                  checked={currentSettings.globalShortcutEnabled}
                  disabled={controlsBusy}
                  label={t("settings.shortcut.label")}
                  description={t("settings.shortcut.description")}
                  onChange={() => void applyOptimisticSettings({ globalShortcutEnabled: !currentSettings.globalShortcutEnabled }, null)}
                />
                {updateStatus && updatePresentation && (
                  <div className="setting-row update-setting-row">
                    <div>
                      <strong>{updateStatus.targetVersion ? t("settings.update.targetVersion", { version: updateStatus.targetVersion }) : t("settings.update.currentVersion", { version: updateStatus.currentVersion })}</strong>
                      <span className={updatePresentation.isError ? "account-error" : ""} aria-live="polite">{updatePresentation.status}</span>
                      {updateStatus.percent !== null && ["available", "downloading", "ready"].includes(updateStatus.phase) && (
                        <progress aria-label={t("settings.update.downloadProgress")} max={100} value={updateStatus.percent} />
                      )}
                    </div>
                    <div className="settings-inline-actions">
                      {updateStatus.phase === "ready" && updateStatus.suppression === "none" ? (
                        <>
                          <button className="primary-button" type="button" disabled={updateControlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("install-update"); }}>
                            <RotateCcw size={15} />{t("settings.update.restartAndUpdate")}
                          </button>
                          <button className="secondary-button" type="button" disabled={updateControlsBusy} onClick={skipUpdate}>
                            {updateActionBusy === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}{t("settings.update.skipVersion")}
                          </button>
                        </>
                      ) : updateStatus.phase === "available" && updateStatus.suppression === "none" ? (
                        <>
                          <button className="primary-button" type="button" disabled={updateControlsBusy} onClick={downloadUpdate}>
                            {updateActionBusy === "download" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{t("settings.update.updateVersion")}
                          </button>
                          <button className="secondary-button" type="button" disabled={updateControlsBusy} onClick={skipUpdate}>
                            {updateActionBusy === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}{t("settings.update.skipVersion")}
                          </button>
                        </>
                      ) : updateStatus.phase !== "unavailable" ? (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={updateControlsBusy || ["checking", "downloading"].includes(updateStatus.phase)}
                          onClick={checkForUpdates}
                        >
                          {updateActionBusy === "check" || updateStatus.phase === "checking" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                          {t("settings.update.check")}
                        </button>
                      ) : null}
                    </div>
                    {["available", "ready"].includes(updateStatus.phase) && updateStatus.suppression === "none" && (
                      <div className="update-snooze-controls" role="group" aria-label={t("settings.update.snoozeGroupLabel")}>
                        <span><Clock3 size={14} aria-hidden="true" />{t("settings.update.snooze")}</span>
                        <ThemedSelect
                          id="settings-update-snooze"
                          value={updateSnoozeMinutes}
                          aria-label={t("settings.update.snoozeSelectLabel")}
                          disabled={updateControlsBusy}
                          onValueChange={(value) => setUpdateSnoozeMinutes(Number(value))}
                        >
                          <option value={60}>{t("settings.update.snooze.oneHour")}</option>
                          <option value={1440}>{t("settings.update.snooze.oneDay")}</option>
                          <option value={10080}>{t("settings.update.snooze.oneWeek")}</option>
                          <option value={43200}>{t("settings.update.snooze.thirtyDays")}</option>
                        </ThemedSelect>
                        <button className="secondary-button" type="button" disabled={updateControlsBusy} onClick={snoozeUpdate}>
                          {updateActionBusy === "snooze" ? <LoaderCircle className="spin" size={15} /> : <Clock3 size={15} />}{t("settings.update.remindMe")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            <section className="settings-section" data-settings-nav="sync" aria-labelledby="sync-settings">
              <div className="settings-section-title">
                <RefreshCw size={16} />
                <div><span>{t("settings.sync.title")}</span><p id="sync-settings">{t("settings.sync.description")}</p></div>
              </div>
              <label className="setting-select-row" htmlFor="refresh-interval">
                <span><strong>{t("settings.sync.refresh.label")}</strong><small>{t("settings.sync.refresh.description")}</small></span>
                <ThemedSelect
                  id="refresh-interval"
                  value={currentSettings.refreshIntervalSeconds}
                  aria-label={t("settings.sync.refresh.label")}
                  disabled={controlsBusy}
                  onValueChange={(value) => void applyOptimisticSettings({ refreshIntervalSeconds: Number(value) as AppSettings["refreshIntervalSeconds"] }, null)}
                >
                  <option value={30}>{t("settings.sync.refresh.thirtySeconds")}</option>
                  <option value={60}>{t("settings.sync.refresh.oneMinute")}</option>
                  <option value={180}>{t("settings.sync.refresh.threeMinutes")}</option>
                  <option value={300}>{t("settings.sync.refresh.fiveMinutes")}</option>
                </ThemedSelect>
              </label>
              <label className="setting-select-row" htmlFor="sync-message-limit">
                <span><strong>{t("settings.sync.limit.label")}</strong><small>{t("settings.sync.limit.description")}</small></span>
                <ThemedSelect
                  id="sync-message-limit"
                  value={currentSettings.syncMessageLimit}
                  aria-label={t("settings.sync.limit.label")}
                  disabled={controlsBusy}
                  onValueChange={(value) => void applyOptimisticSettings({ syncMessageLimit: Number(value) as AppSettings["syncMessageLimit"] }, null)}
                >
                  <option value={0}>{t("settings.sync.limit.all")}</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                  <option value={2000}>2000</option>
                  <option value={5000}>5000</option>
                </ThemedSelect>
              </label>
              {currentSettings.effectiveSyncMessageLimit != null && currentSettings.effectiveSyncMessageLimit !== currentSettings.syncMessageLimit && (
                <p className="settings-note" role="status">{t("settings.sync.limit.effectiveHint", { limit: currentSettings.effectiveSyncMessageLimit })}</p>
              )}
              <Switch
                checked={currentSettings.realtimePushEnabled}
                disabled={controlsBusy}
                label={t("settings.sync.realtime.label")}
                description={t("settings.sync.realtime.description")}
                onChange={() => void applyOptimisticSettings({ realtimePushEnabled: !currentSettings.realtimePushEnabled }, null)}
              />
            </section>

            <FilterRulesSection accounts={accounts} demoMode={demoMode} />

            <SettingsAgentSection
              t={t}
              formatDate={formatDate}
              accounts={accounts}
              currentSettings={currentSettings}
              controlsBusy={controlsBusy}
              demoMode={demoMode}
              requestAgentProviderSettings={requestAgentProviderSettings}
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
            />

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
          </div>
        </div>

        <footer className="settings-footer">
          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("restore-defaults"); }}>
            {busyAction === "restore-defaults" ? <LoaderCircle className="spin" size={15} /> : <Undo2 size={15} />}{t("settings.defaults.restore")}
          </button>
          <button className="primary-button" type="button" disabled={controlsBusy} onClick={requestClose}>{t("settings.done")}</button>
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
                  else if (action === "discard-translation-changes-and-open-agent") onOpenAgentProviderSettings();
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
