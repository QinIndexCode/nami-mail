import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import {
  Bell,
  Check,
  CircleHelp,
  Clock3,
  Download,
  Eye,
  EyeOff,
  ImagePlus,
  KeyRound,
  Laptop,
  Languages,
  LoaderCircle,
  Mail,
  Minimize2,
  Moon,
  Palette,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  SkipForward,
  Sun,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api, type TranslationConfiguration } from "./api";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import { accountHealthIssue, mailErrorMessage } from "./errorPresentation";
import { translate, useI18n } from "./i18n";
import { providerDisplayName } from "./providerOnboarding";
import { canPlayCustomNotificationSound, playNotificationSound, primeNotificationSound } from "./sounds";
import ThemedSelect from "./ThemedSelect";
import {
  hasUnsavedTranslationConfiguration,
  translationConfigurationErrorMessage,
  translationConfigurationStatusMessage,
} from "./translationPresentation";
import { presentUpdateSnapshot } from "./updatePresentation";
import { useDialogFocus } from "./useDialogFocus";
import type {
  Account,
  AppSettings,
  AppSettingsPatch,
  AppTheme,
  BackgroundPreset,
  CloseBehavior,
  NotificationSound,
} from "./types";
import { defaultAppSettings } from "./types";

const isDesktopRuntime = new URLSearchParams(window.location.search).get("desktop") === "1";

export type BackgroundPresetOption = {
  id: Exclude<BackgroundPreset, "custom">;
  labelKey: string;
  descriptionKey: string;
  image?: string;
};

export const backgroundPresetOptions: readonly BackgroundPresetOption[] = [
  { id: "none", labelKey: "settings.backgroundPreset.none.label", descriptionKey: "settings.backgroundPreset.none.description" },
  { id: "paper", labelKey: "settings.backgroundPreset.paper.label", descriptionKey: "settings.backgroundPreset.paper.description", image: "/backgrounds/paper.png" },
  { id: "mist", labelKey: "settings.backgroundPreset.mist.label", descriptionKey: "settings.backgroundPreset.mist.description", image: "/backgrounds/mist.png" },
  { id: "coast", labelKey: "settings.backgroundPreset.coast.label", descriptionKey: "settings.backgroundPreset.coast.description", image: "/backgrounds/coast.png" },
  { id: "dawn", labelKey: "settings.backgroundPreset.dawn.label", descriptionKey: "settings.backgroundPreset.dawn.description", image: "/backgrounds/dawn.png" },
  { id: "night", labelKey: "settings.backgroundPreset.night.label", descriptionKey: "settings.backgroundPreset.night.description", image: "/backgrounds/night.png" },
];

export type SettingsModalProps = {
  settings: AppSettings;
  accounts: Account[];
  onClose: () => void;
  /** Receives the fully persisted settings result, not a partial patch. */
  onSettingsChange: (next: AppSettings) => void | Promise<void>;
  /** Called after the account has been removed, or directly in demo mode. */
  onAccountRemoved: (accountId: string) => void | Promise<void>;
  /** Retries a single account and lets the host refresh its health state. */
  onAccountSync?: (accountId: string) => Promise<{ synced: number; folders: number; failedFolders: number }>;
  /** Lets the host own native desktop notification testing when desired. */
  onTestNotification?: (settings: AppSettings) => void | Promise<void>;
  /** Lets the host share its notification-audio policy with this modal. */
  onTestSound?: (sound: NotificationSound) => void | Promise<void>;
  /** Refreshes reader translation status after service configuration changes. */
  onTranslationConfigurationChanged?: () => void | Promise<void>;
  /** Visible control used only when the original trigger disappears, such as a closed mobile drawer. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Demo settings are intentionally in-memory and are never sent to the local API. */
  demoMode?: boolean;
};

type Notice = { kind: "success" | "error"; message: string } | null;
type PendingSettingsConfirmation =
  | "clear-background"
  | "restore-defaults"
  | "install-update"
  | "remove-translation-configuration"
  | "remove-translation-api-key"
  | "discard-translation-changes";

const restoreDefaultsPatch: AppSettingsPatch = {
  theme: defaultAppSettings.theme,
  locale: defaultAppSettings.locale,
  backgroundPreset: defaultAppSettings.backgroundPreset,
  backgroundIntensity: defaultAppSettings.backgroundIntensity,
  notificationsEnabled: defaultAppSettings.notificationsEnabled,
  notifyWhenFocused: defaultAppSettings.notifyWhenFocused,
  notificationSound: defaultAppSettings.notificationSound,
  refreshIntervalSeconds: defaultAppSettings.refreshIntervalSeconds,
  closeBehavior: defaultAppSettings.closeBehavior,
};

const maxBackgroundUploadBytes = 50 * 1024 * 1024;
const backgroundContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type TranslatedOption<T extends string> = { value: T; labelKey: string; detailKey: string };

const themeOptions: Array<TranslatedOption<AppTheme>> = [
  { value: "system", labelKey: "settings.theme.system.label", detailKey: "settings.theme.system.detail" },
  { value: "light", labelKey: "settings.theme.light.label", detailKey: "settings.theme.light.detail" },
  { value: "dark", labelKey: "settings.theme.dark.label", detailKey: "settings.theme.dark.detail" },
];

const soundOptions: Array<TranslatedOption<NotificationSound>> = [
  { value: "system", labelKey: "settings.sound.system.label", detailKey: "settings.sound.system.detail" },
  { value: "soft", labelKey: "settings.sound.soft.label", detailKey: "settings.sound.soft.detail" },
  { value: "bright", labelKey: "settings.sound.bright.label", detailKey: "settings.sound.bright.detail" },
  { value: "none", labelKey: "settings.sound.none.label", detailKey: "settings.sound.none.detail" },
];

const closeBehaviorOptions: Array<TranslatedOption<CloseBehavior>> = [
  { value: "ask", labelKey: "settings.closeBehavior.ask.label", detailKey: "settings.closeBehavior.ask.detail" },
  { value: "tray", labelKey: "settings.closeBehavior.tray.label", detailKey: "settings.closeBehavior.tray.detail" },
  { value: "quit", labelKey: "settings.closeBehavior.quit.label", detailKey: "settings.closeBehavior.quit.detail" },
];

function errorMessage(error: unknown, fallback: string, t: ReturnType<typeof useI18n>["t"]): string {
  return mailErrorMessage(error, fallback, t);
}

function backgroundContentTypeForFile(file: File): string | undefined {
  if (backgroundContentTypes.has(file.type)) return file.type;
  const filename = file.name.toLowerCase();
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return undefined;
}

function revokeDemoObjectUrl(url: string | null | undefined): void {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

function Switch({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <div className="setting-row setting-switch-row">
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <button
        className={`setting-switch${checked ? " active" : ""}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

function ThemeIcon({ value }: { value: AppTheme }) {
  if (value === "light") return <Sun size={17} />;
  if (value === "dark") return <Moon size={17} />;
  return <Laptop size={17} />;
}

function CloseBehaviorIcon({ value }: { value: CloseBehavior }) {
  if (value === "tray") return <Minimize2 size={17} />;
  if (value === "quit") return <Power size={17} />;
  return <CircleHelp size={17} />;
}

export default function SettingsModal({
  settings,
  accounts,
  onClose,
  onSettingsChange,
  onAccountRemoved,
  onAccountSync,
  onTestNotification,
  onTestSound,
  onTranslationConfigurationChanged,
  fallbackFocusRef,
  demoMode = false,
}: SettingsModalProps) {
  const { locale, locales, setLocale, t } = useI18n();
  const [currentSettings, setCurrentSettings] = useState(settings);
  const [notice, setNotice] = useState<Notice>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [intensityDraft, setIntensityDraft] = useState(settings.backgroundIntensity);
  const [pendingAccountRemoval, setPendingAccountRemoval] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingSettingsConfirmation | null>(null);
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
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const backgroundAlert = useRef<HTMLElement>(null);
  const pendingRemovalAccount = accounts.find((account) => account.id === pendingAccountRemoval) ?? null;
  const activeLocale = currentSettings.locale || locale;
  const controlsBusy = Boolean(busyAction || updateActionBusy === "install");
  const updatePresentation = updateStatus ? presentUpdateSnapshot(updateStatus, t) : null;
  const hasUnsavedTranslationDraft = hasUnsavedTranslationConfiguration(translationConfiguration, {
    endpoint: translationEndpoint,
    apiKey: translationApiKey,
    timeoutMs: translationTimeoutMs,
  });

  const dismissBackgroundUploadError = () => {
    setBackgroundUploadError(null);
  };

  const requestClose = () => {
    if (controlsBusy) return;
    if (hasUnsavedTranslationDraft) {
      setPendingConfirmation("discard-translation-changes");
      return;
    }
    onClose();
  };

  useEffect(() => {
    setCurrentSettings(settings);
  }, [settings]);

  useEffect(() => {
    setIntensityDraft(currentSettings.backgroundIntensity);
  }, [currentSettings.backgroundIntensity]);

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
      // The select owns Escape while its listbox is expanded. This listener is
      // capture-phase so without the guard it would close the whole dialog
      // before the combobox has a chance to close only its own menu.
      if (target?.closest(".select-control")?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (controlsBusy) return;
      if (backgroundUploadError) {
        dismissBackgroundUploadError();
        return;
      }
      if (pendingConfirmation) {
        setPendingConfirmation(null);
        return;
      }
      if (pendingRemovalAccount) {
        setPendingAccountRemoval(null);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [backgroundUploadError, controlsBusy, pendingConfirmation, pendingRemovalAccount, requestClose]);

  useDialogFocus(true, settingsDialog, { fallbackFocusRef, suspended: Boolean(pendingConfirmation || pendingRemovalAccount || backgroundUploadError) });
  useDialogFocus(Boolean(pendingConfirmation || pendingRemovalAccount), confirmationDialog, { fallbackFocusRef: settingsDialog });
  useDialogFocus(Boolean(backgroundUploadError), backgroundAlert, { restoreFocusRef: uploadButton });

  const publishSettings = async (next: AppSettings): Promise<AppSettings> => {
    setCurrentSettings(next);
    await onSettingsChange(next);
    return next;
  };

  const saveSettings = async (
    patch: AppSettingsPatch,
    action: string,
    successMessage: string,
    preserveSuccessLocale = false,
  ): Promise<AppSettings | undefined> => {
    if (busyAction) return undefined;
    setBusyAction(action);
    setNotice(null);
    try {
      const next = demoMode
        ? { ...currentSettings, ...patch, updatedAt: new Date().toISOString() }
        : await api.updateSettings(patch);
      await publishSettings(next);
      setNotice({
        kind: "success",
        message: demoMode && !preserveSuccessLocale ? t("settings.demo.resetAfterSession", { message: successMessage }) : successMessage,
      });
      return next;
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.save"), t) });
      return undefined;
    } finally {
      setBusyAction(null);
    }
  };

  const changeLocale = (nextLocale: string) => {
    if (nextLocale === currentSettings.locale || busyAction) return;
    const updatedMessage = translate(nextLocale, "language.updated");
    const successMessage = demoMode
      ? translate(nextLocale, "settings.demo.resetAfterSession", { message: updatedMessage })
      : updatedMessage;
    void saveSettings({ locale: nextLocale }, "locale", successMessage, true);
  };

  const choosePreset = (preset: Exclude<BackgroundPreset, "custom">) => {
    void saveSettings({ backgroundPreset: preset }, `background-${preset}`, t("settings.background.updated"));
  };

  const commitIntensity = () => {
    if (intensityDraft === currentSettings.backgroundIntensity || busyAction) return;
    void saveSettings({ backgroundIntensity: intensityDraft }, "background-intensity", t("settings.background.intensityUpdated"));
  };

  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busyAction) return;
    const contentType = backgroundContentTypeForFile(file);
    if (!contentType) {
      setBackgroundUploadError(t("settings.background.unsupportedFile", { filename: file.name }));
      return;
    }
    if (file.size > maxBackgroundUploadBytes) {
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
      setBackgroundUploadError(errorMessage(error, t("settings.error.saveCustomBackground"), t));
    } finally {
      setBusyAction(null);
    }
  };

  const chooseCustomBackground = () => {
    if (currentSettings.customBackgroundUrl) {
      void saveSettings({ backgroundPreset: "custom" }, "background-custom", t("settings.background.customSelected"));
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

  const removeAccount = async (accountId: string) => {
    if (busyAction) return;
    setBusyAction(`account-remove-${accountId}`);
    setNotice(null);
    try {
      if (!demoMode) await api.removeAccount(accountId);
      await onAccountRemoved(accountId);
      setPendingAccountRemoval(null);
      setNotice({
        kind: "success",
        message: demoMode ? t("settings.account.removedFromDemo") : t("settings.account.removed"),
      });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, t("settings.error.removeAccount"), t) });
      setPendingAccountRemoval(null);
    } finally {
      setBusyAction(null);
    }
  };

  const retryAccount = async (account: Account) => {
    if (busyAction) return;
    setBusyAction(`account-sync-${account.id}`);
    setNotice(null);
    try {
      const result = onAccountSync
        ? await onAccountSync(account.id)
        : demoMode
          ? { synced: 0, folders: 0, failedFolders: 0 }
          : await api.sync(account.id);
      const summary = result.failedFolders
        ? t("settings.account.syncPartial", { email: account.email, failedFolders: result.failedFolders })
        : result.synced
          ? t("settings.account.syncCompletedWithMessages", { email: account.email, synced: result.synced })
          : t("settings.account.syncCompleted", { email: account.email });
      setNotice({ kind: result.failedFolders ? "error" : "success", message: summary });
    } catch (error) {
      setNotice({ kind: "error", message: t("settings.account.syncFailed", { email: account.email, message: mailErrorMessage(error, undefined, t) }) });
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
  const dismissConfirmation = () => {
    if (controlsBusy) return;
    setPendingConfirmation(null);
    setPendingAccountRemoval(null);
  };
  const confirmationTitle = pendingRemovalAccount
    ? t("settings.confirmation.removeAccountTitle", { email: pendingRemovalAccount.email })
    : pendingConfirmation === "clear-background"
      ? t("settings.confirmation.clearBackgroundTitle")
      : pendingConfirmation === "install-update"
        ? t("settings.confirmation.installUpdateTitle")
        : pendingConfirmation === "remove-translation-configuration"
          ? t("settings.confirmation.removeTranslationServiceTitle")
          : pendingConfirmation === "remove-translation-api-key"
            ? t("settings.confirmation.removeTranslationApiKeyTitle")
            : pendingConfirmation === "discard-translation-changes"
              ? t("settings.confirmation.discardTranslationChangesTitle")
              : t("settings.confirmation.restoreDefaultsTitle");
  const confirmationDescription = pendingRemovalAccount
    ? t("settings.confirmation.removeAccountDescription")
    : pendingConfirmation === "clear-background"
      ? t("settings.confirmation.clearBackgroundDescription")
      : pendingConfirmation === "install-update"
        ? t("settings.confirmation.installUpdateDescription")
        : pendingConfirmation === "remove-translation-configuration"
          ? t("settings.confirmation.removeTranslationServiceDescription")
          : pendingConfirmation === "remove-translation-api-key"
            ? t("settings.confirmation.removeTranslationApiKeyDescription")
            : pendingConfirmation === "discard-translation-changes"
              ? t("settings.confirmation.discardTranslationChangesDescription")
              : t("settings.confirmation.restoreDefaultsDescription");
  const confirmationAction = pendingRemovalAccount
    ? t("settings.confirmation.removeAccountAction")
    : pendingConfirmation === "clear-background"
      ? t("settings.confirmation.clearBackgroundAction")
      : pendingConfirmation === "install-update"
        ? t("settings.update.restartAndUpdate")
        : pendingConfirmation === "remove-translation-configuration"
          ? t("settings.confirmation.removeTranslationServiceAction")
          : pendingConfirmation === "remove-translation-api-key"
            ? t("settings.confirmation.removeTranslationApiKeyAction")
            : pendingConfirmation === "discard-translation-changes"
              ? t("settings.confirmation.discardTranslationChangesAction")
              : t("settings.confirmation.restoreDefaultsAction");

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section ref={settingsDialog} className="modal-card settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <header className="modal-heading settings-heading">
          <div>
            <span className="eyebrow">{t("settings.eyebrow")}</span>
            <h2 id="settings-title">{t("settings.title")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("settings.close")} data-tooltip={t("settings.close")} disabled={controlsBusy} onClick={requestClose}>
            <X size={18} />
          </button>
        </header>

        {notice && <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}{notice.message}</div>}

        <section className="settings-section" aria-labelledby="language-settings">
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

        <section className="settings-section" aria-labelledby="appearance-settings">
          <div className="settings-section-title">
            <Palette size={16} />
            <div><span>{t("settings.appearance.title")}</span><p id="appearance-settings">{t("settings.appearance.description")}</p></div>
          </div>

          <div className="settings-option-grid theme-option-grid" role="group" aria-label={t("settings.theme.groupLabel")}>
            {themeOptions.map((option) => (
              <button
                key={option.value}
                className={`settings-option${currentSettings.theme === option.value ? " active" : ""}`}
                type="button"
                aria-pressed={currentSettings.theme === option.value}
                disabled={controlsBusy}
                onClick={() => void saveSettings({ theme: option.value }, `theme-${option.value}`, t("settings.theme.updated"))}
              >
                <ThemeIcon value={option.value} />
                <span><strong>{t(option.labelKey)}</strong><small>{t(option.detailKey)}</small></span>
                {currentSettings.theme === option.value && <Check className="option-check" size={15} />}
              </button>
            ))}
          </div>

          <div className="setting-subheading"><span>{t("settings.background.title")}</span><small>{t("settings.background.offlineHint")}</small></div>
          <div className="background-preset-grid" role="group" aria-label={t("settings.background.presetGroupLabel")}>
            {backgroundPresetOptions.map((preset) => {
              const active = currentSettings.backgroundPreset === preset.id;
              return (
                <button
                  key={preset.id}
                  className={`background-preset${active ? " active" : ""}`}
                  type="button"
                  aria-pressed={active}
                  disabled={controlsBusy}
                  onClick={() => choosePreset(preset.id)}
                >
                  <span
                    className={`background-preview background-${preset.id}`}
                    aria-hidden="true"
                  >
                    {preset.image && <span className="background-preview-image" style={{ backgroundImage: `url(${preset.image})`, opacity: currentSettings.backgroundIntensity / 100 }} />}
                  </span>
                  <span><strong>{t(preset.labelKey)}</strong><small>{t(preset.descriptionKey)}</small></span>
                  {active && <Check className="option-check" size={14} />}
                </button>
              );
            })}
            <button
              className={`background-preset custom-background-preset${currentSettings.backgroundPreset === "custom" ? " active" : ""}`}
              type="button"
              aria-pressed={currentSettings.backgroundPreset === "custom"}
              disabled={controlsBusy}
              onClick={chooseCustomBackground}
            >
              <span
                className="background-preview background-custom"
                aria-hidden="true"
              >
                {hasCustomBackground && <span className="background-preview-image" style={{ backgroundImage: `url(${currentSettings.customBackgroundUrl})`, opacity: currentSettings.backgroundIntensity / 100 }} />}
                {!hasCustomBackground && <ImagePlus size={18} />}
              </span>
              <span><strong>{t("settings.background.custom.label")}</strong><small>{hasCustomBackground ? (demoMode ? t("settings.background.custom.demoOnly") : t("settings.background.custom.savedOnDevice")) : t("settings.background.custom.localImage")}</small></span>
              {currentSettings.backgroundPreset === "custom" && <Check className="option-check" size={14} />}
            </button>
          </div>
          <input ref={uploadInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadBackground(event)} />

          <div className="background-controls">
            <label className="setting-range" htmlFor="background-intensity">
              <span><strong>{t("settings.background.intensity")}</strong><small>{intensityDraft}%</small></span>
              <input
                id="background-intensity"
                type="range"
                min="0"
                max="80"
                step="1"
                value={intensityDraft}
                disabled={controlsBusy}
                onChange={(event) => setIntensityDraft(Number(event.target.value))}
                onBlur={commitIntensity}
                onPointerUp={commitIntensity}
                onKeyUp={(event) => {
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) commitIntensity();
                }}
              />
            </label>
            <div className="background-actions">
              <button ref={uploadButton} className="secondary-button" type="button" disabled={controlsBusy} onClick={() => uploadInput.current?.click()}>
                {busyAction === "background-upload" ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
                {hasCustomBackground ? t("settings.background.replaceImage") : t("settings.background.uploadImage")}
              </button>
              {hasCustomBackground && (
                <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => setPendingConfirmation("clear-background")}>
                  {busyAction === "background-remove" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                  {t("settings.background.clear")}
                </button>
              )}
            </div>
          </div>
          <p className="background-upload-hint">{t("settings.background.uploadHint")}</p>
        </section>

        <section className="settings-section" aria-labelledby="notification-settings">
          <div className="settings-section-title">
            <Bell size={16} />
            <div><span>{t("settings.notifications.title")}</span><p id="notification-settings">{t("settings.notifications.description")}</p></div>
          </div>
          <Switch
            checked={currentSettings.notificationsEnabled}
            disabled={controlsBusy}
            label={t("settings.notifications.desktop.label")}
            description={t("settings.notifications.desktop.description")}
            onChange={() => void saveSettings({ notificationsEnabled: !currentSettings.notificationsEnabled }, "notifications", currentSettings.notificationsEnabled ? t("settings.notifications.desktop.disabled") : t("settings.notifications.desktop.enabled"))}
          />
          <Switch
            checked={currentSettings.notifyWhenFocused}
            disabled={controlsBusy || !currentSettings.notificationsEnabled}
            label={t("settings.notifications.focused.label")}
            description={t("settings.notifications.focused.description")}
            onChange={() => void saveSettings({ notifyWhenFocused: !currentSettings.notifyWhenFocused }, "notify-focused", currentSettings.notifyWhenFocused ? t("settings.notifications.focused.disabled") : t("settings.notifications.focused.enabled"))}
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
                onClick={() => void saveSettings({ notificationSound: option.value }, `sound-${option.value}`, t("settings.sound.updated"))}
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
          <section className="settings-section" aria-labelledby="desktop-settings">
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
                  onClick={() => void saveSettings({ closeBehavior: option.value }, `close-${option.value}`, t("settings.closeBehavior.updated"))}
                >
                  <CloseBehaviorIcon value={option.value} />
                  <span><strong>{t(option.labelKey)}</strong><small>{t(option.detailKey)}</small></span>
                  {currentSettings.closeBehavior === option.value && <Check className="option-check" size={15} />}
                </button>
              ))}
            </div>
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
                      <button className="primary-button" type="button" disabled={updateControlsBusy} onClick={() => setPendingConfirmation("install-update")}>
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

        <section className="settings-section" aria-labelledby="sync-settings">
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
              onValueChange={(value) => void saveSettings({ refreshIntervalSeconds: Number(value) as AppSettings["refreshIntervalSeconds"] }, "refresh-interval", t("settings.sync.refresh.updated"))}
            >
              <option value={30}>{t("settings.sync.refresh.thirtySeconds")}</option>
              <option value={60}>{t("settings.sync.refresh.oneMinute")}</option>
              <option value={180}>{t("settings.sync.refresh.threeMinutes")}</option>
              <option value={300}>{t("settings.sync.refresh.fiveMinutes")}</option>
            </ThemedSelect>
          </label>
        </section>

        <section className="settings-section" aria-labelledby="translation-settings">
          <div className="settings-section-title">
            <KeyRound size={16} />
            <div><span>{t("settings.translation.title")}</span><p id="translation-settings">{demoMode ? t("settings.translation.demoDescription") : t("settings.translation.description")}</p></div>
          </div>
          {demoMode ? null : translationConfigurationLoading ? (
            <p className="settings-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("common.loading")}</p>
          ) : translationConfiguration ? (
            <form className="translation-settings-form" onSubmit={(event) => {
              event.preventDefault();
              void saveTranslationConfiguration();
            }}>
              <label className="translation-setting-field" htmlFor="translation-service-endpoint">
                <span><strong>{t("settings.translation.endpoint")}</strong><small>{t("settings.translation.endpointHint")}</small></span>
                <input
                  id="translation-service-endpoint"
                  type="url"
                  value={translationEndpoint}
                  placeholder={t("settings.translation.endpointPlaceholder")}
                  autoComplete="url"
                  spellCheck={false}
                  required
                  disabled={controlsBusy}
                  onChange={(event) => setTranslationEndpoint(event.target.value)}
                />
              </label>
              <label className="translation-setting-field" htmlFor="translation-service-key">
                <span>
                  <strong>{t("settings.translation.apiKey")}</strong>
                  <small>{translationApiKeyHint}</small>
                </span>
                <span className="translation-secret-input">
                  <input
                    id="translation-service-key"
                    type={translationApiKeyVisible ? "text" : "password"}
                    value={translationApiKey}
                    placeholder={t("settings.translation.apiKeyPlaceholder")}
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={controlsBusy}
                    onChange={(event) => setTranslationApiKey(event.target.value)}
                  />
                  <button
                    className="icon-button translation-key-visibility"
                    type="button"
                    aria-label={translationApiKeyVisible ? t("settings.translation.hideApiKey") : t("settings.translation.showApiKey")}
                    aria-pressed={translationApiKeyVisible}
                    data-tooltip={translationApiKeyVisible ? t("settings.translation.hideApiKey") : t("settings.translation.showApiKey")}
                    disabled={controlsBusy || !translationApiKey}
                    onClick={() => setTranslationApiKeyVisible((value) => !value)}
                  >
                    {translationApiKeyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </span>
              </label>
              <label className="translation-setting-field translation-timeout-field" htmlFor="translation-service-timeout">
                <span><strong>{t("settings.translation.timeout")}</strong><small>{t("settings.translation.timeoutHint")}</small></span>
                <input
                  id="translation-service-timeout"
                  type="number"
                  min="1000"
                  max="60000"
                  step="1000"
                  value={translationTimeoutMs}
                  disabled={controlsBusy}
                  onChange={(event) => setTranslationTimeoutMs(Number(event.target.value))}
                />
              </label>
              <div className="translation-configuration-meta" role="status" aria-live="polite">
                <span className={`status-dot ${translationConfiguration.enabled && !translationConfiguration.configurationError ? "connected" : "error"}`} aria-hidden="true" />
                <span>{translationConfigurationStatusMessage(translationConfiguration, t)}</span>
                {translationConfiguration.apiKeyConfigured && !translationConfiguration.configurationError && <small>{t("settings.translation.keySaved")}</small>}
              </div>
              <div className="settings-inline-actions">
                <button className="primary-button" type="submit" disabled={controlsBusy || translationConfigurationNeedsReplacementKey}>
                  {busyAction === "translation-configuration" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                  {busyAction === "translation-configuration" ? t("settings.translation.saving") : t("settings.translation.save")}
                </button>
                {translationConfiguration.source === "local" && translationConfiguration.apiKeyConfigured && (
                  <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => setPendingConfirmation("remove-translation-api-key")}>
                    <KeyRound size={15} />{t("settings.translation.removeKey")}
                  </button>
                )}
                {translationConfiguration.source === "local" && (
                  <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => setPendingConfirmation("remove-translation-configuration")}>
                    <Trash2 size={15} />{t("settings.translation.removeService")}
                  </button>
                )}
              </div>
            </form>
          ) : (
            <div className="settings-empty translation-configuration-load-error" role="alert">
              <span>{translationConfigurationErrorMessage(translationConfigurationError, t, "settings.translation.loadFailed")}</span>
              <button className="secondary-button" type="button" disabled={controlsBusy || translationConfigurationLoading} onClick={retryTranslationConfigurationLoad}>
                <RefreshCw size={15} aria-hidden="true" />{t("common.retry")}
              </button>
            </div>
          )}
        </section>

        <section className="settings-section settings-accounts" aria-labelledby="account-settings">
          <div className="settings-section-title">
            <Mail size={16} />
            <div><span>{t("settings.account.title")}</span><p id="account-settings">{demoMode ? t("settings.account.demoDescription") : t("settings.account.description")}</p></div>
          </div>
          {accounts.length === 0 ? (
            <p className="settings-empty">{t("settings.account.empty")}</p>
          ) : (
            <div className="settings-account-list">
              {accounts.map((account) => {
                const issue = accountHealthIssue(account, t);
                const retrying = busyAction === `account-sync-${account.id}`;
                const providerName = providerDisplayName({ id: account.provider, name: account.providerName }, locale, t);
                return (
                  <div className="settings-account" key={account.id}>
                    <div className="settings-account-copy">
                      <span className={`status-dot ${issue ? "error" : account.status}`} aria-hidden="true" />
                      <span>
                        <strong>{account.email}</strong>
                        <small className={`${issue ? "account-error " : ""}truncated-tooltip`} data-tooltip={issue ? `${issue.message} ${issue.guidance}` : providerName}><span>{issue ? `${providerName} · ${issue.title}` : providerName}</span></small>
                        {issue && <small className="account-error-guidance">{issue.guidance}</small>}
                      </span>
                    </div>
                    <div className="settings-account-actions">
                      {issue?.retryable && (
                        <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void retryAccount(account)}>
                          {retrying ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t("settings.account.resync")}
                        </button>
                      )}
                      <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.account.removeAriaLabel", { email: account.email })} data-tooltip={t("settings.account.removeTooltip")} disabled={controlsBusy} onClick={() => setPendingAccountRemoval(account.id)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <footer className="settings-footer">
          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setPendingConfirmation("restore-defaults")}>
            {busyAction === "restore-defaults" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{t("settings.defaults.restore")}
          </button>
          <button className="primary-button" type="button" disabled={controlsBusy} onClick={requestClose}>{t("settings.done")}</button>
        </footer>
      </section>
      {(pendingConfirmation || pendingRemovalAccount) && (
        <div className="modal-backdrop confirmation-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && dismissConfirmation()}>
          <section ref={confirmationDialog} className="confirmation-card" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirmation-title" aria-describedby="settings-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            <h3 id="settings-confirmation-title">{confirmationTitle}</h3>
            <p id="settings-confirmation-description">{confirmationDescription}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={controlsBusy} onClick={dismissConfirmation}>{t("common.cancel")}</button>
              <button
                className={pendingConfirmation === "install-update" ? "primary-button" : "secondary-button danger-button"}
                type="button"
                disabled={controlsBusy}
                onClick={() => {
                  if (pendingRemovalAccount) {
                    void removeAccount(pendingRemovalAccount.id);
                    return;
                  }
                  const action = pendingConfirmation;
                  setPendingConfirmation(null);
                  if (action === "clear-background") void clearCustomBackground();
                  else if (action === "install-update") void installUpdate();
                  else if (action === "remove-translation-configuration") void removeTranslationConfiguration();
                  else if (action === "remove-translation-api-key") void removeTranslationApiKey();
                  else if (action === "discard-translation-changes") onClose();
                  else void restoreDefaults();
                }}
              >
                {pendingRemovalAccount && busyAction === `account-remove-${pendingRemovalAccount.id}` ? <LoaderCircle className="spin" size={14} /> : pendingRemovalAccount ? <Trash2 size={14} /> : pendingConfirmation === "install-update" ? <RotateCcw size={14} /> : pendingConfirmation === "remove-translation-configuration" ? <Trash2 size={14} /> : pendingConfirmation === "remove-translation-api-key" ? <KeyRound size={14} /> : pendingConfirmation === "discard-translation-changes" ? <X size={14} /> : null}
                {confirmationAction}
              </button>
            </div>
          </section>
        </div>
      )}
      {backgroundUploadError && (
        <div className="modal-backdrop settings-alert-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && dismissBackgroundUploadError()}>
          <section ref={backgroundAlert} className="settings-alert-card" role="alertdialog" aria-modal="true" aria-labelledby="background-upload-error-title" aria-describedby="background-upload-error-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.background.alertEyebrow")}</span>
            <h3 id="background-upload-error-title">{t("settings.background.alertTitle")}</h3>
            <p id="background-upload-error-description">{backgroundUploadError}</p>
            <div className="settings-alert-actions">
              <button className="primary-button" type="button" onClick={dismissBackgroundUploadError}>{t("settings.background.alertDismiss")}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
