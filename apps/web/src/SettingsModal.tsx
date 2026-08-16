import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import {
  Bell,
  BookOpen,
  Bot,
  Check,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  Eye,
  EyeOff,
  ImagePlus,
  KeyRound,
  Laptop,
  Languages,
  LoaderCircle,
  Globe,
  MessageSquareReply,
  MessageSquareX,
  Minimize2,
  Moon,
  Palette,
  Server,
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
  Wrench,
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
import AutoReplyScopeEditor from "./AutoReplyScopeEditor";
import AutoReplyDecisionsDialog from "./AutoReplyDecisionsDialog";
import { translate, useI18n } from "./i18n";
import { canPlayCustomNotificationSound, playNotificationSound, primeNotificationSound } from "./sounds";
import ThemedSelect from "./ThemedSelect";
import {
  hasUnsavedTranslationConfiguration,
  translationConfigurationErrorMessage,
  translationConfigurationStatusMessage,
} from "./translationPresentation";
import { presentUpdateSnapshot } from "./updatePresentation";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";
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

const isDesktopRuntime = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("desktop") === "1";

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
  agentToolRoundLimit: defaultAppSettings.agentToolRoundLimit,
  listDensity: defaultAppSettings.listDensity,
  avatarGravatarEnabled: defaultAppSettings.avatarGravatarEnabled,
};

const maxBackgroundUploadBytes = 50 * 1024 * 1024;
const backgroundContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type TranslatedOption<T extends string> = { value: T; labelKey: string; detailKey: string };

const themeOptions: Array<TranslatedOption<AppTheme>> = [
  { value: "system", labelKey: "settings.theme.system.label", detailKey: "settings.theme.system.detail" },
  { value: "light", labelKey: "settings.theme.light.label", detailKey: "settings.theme.light.detail" },
  { value: "dark", labelKey: "settings.theme.dark.label", detailKey: "settings.theme.dark.detail" },
];
const listDensityOptions: Array<TranslatedOption<ListDensity>> = [
  { value: "comfortable", labelKey: "settings.density.comfortable.label", detailKey: "settings.density.comfortable.detail" },
  { value: "compact", labelKey: "settings.density.compact.label", detailKey: "settings.density.compact.detail" },
];
const agentAccessLevelOptions: Array<TranslatedOption<AgentAccessLevel>> = [
  { value: "read-only", labelKey: "settings.agent.accessLevel.readOnly", detailKey: "settings.agent.accessLevel.readOnly.detail" },
  { value: "send-confirmed", labelKey: "settings.agent.accessLevel.sendConfirmed", detailKey: "settings.agent.accessLevel.sendConfirmed.detail" },
  { value: "full-access", labelKey: "settings.agent.accessLevel.fullAccess", detailKey: "settings.agent.accessLevel.fullAccess.detail" },
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

const externalCliGuideCode = "namimail pair\nnamimail status";
const externalMcpGuideCode = [
  "{",
  '  "mcpServers": {',
  '    "namimail": {',
  '      "command": "cmd.exe",',
  '      "args": ["/d", "/s", "/c", "namimail mcp start"]',
  "    }",
  "  }",
  "}",
].join("\n");
const externalServiceGuideCode = "namimail service start\nnamimail service stop";
const externalDocsUrl = "https://github.com/QinIndexCode/nami-mail";

function ExternalGuideBlock(props: {
  id: string;
  label: string;
  hint: string;
  code: string;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const { t } = useI18n();
  const copied = props.copiedId === props.id;
  return (
    <div className="external-guide-block">
      <div className="external-guide-block-head">
        <span>
          <strong>{props.label}</strong>
          <small>{props.hint}</small>
        </span>
        <button
          className="secondary-button"
          type="button"
          disabled={copied}
          aria-label={copied ? t("settings.agent.externalGuide.copied") : `${t("settings.agent.externalGuide.copy")} ${props.label}`}
          onClick={() => props.onCopy(props.code, props.id)}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t("settings.agent.externalGuide.copied") : t("settings.agent.externalGuide.copy")}
        </button>
      </div>
      <pre className="external-guide-code"><code>{props.code}</code></pre>
    </div>
  );
}

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

/**
 * Copies guide snippets to the clipboard with a short-lived fallback for
 * local sessions where clipboard permissions are unavailable.
 */
async function copyGuideTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the short-lived selection fallback below.
  }
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
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

function NumberStepper({ value, min, max, onChange, disabled, decreaseLabel = "Decrease", increaseLabel = "Increase" }: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  decreaseLabel?: string;
  increaseLabel?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="number-stepper">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label={decreaseLabel}>−</button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(clamp(n));
        }}
      />
      <button type="button" onClick={() => onChange(clamp(value + 1))} disabled={disabled || value >= max} aria-label={increaseLabel}>+</button>
    </div>
  );
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
  const [pendingFullAccess, setPendingFullAccess] = useState<{ patch: AppSettingsPatch; successMessage: string } | null>(null);
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
    successMessage: string,
    preserveSuccessLocale = false,
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
      setNotice({
        kind: "success",
        message: demoMode && !preserveSuccessLocale ? t("settings.demo.resetAfterSession", { message: successMessage }) : successMessage,
      });
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
  const requestAccessLevelChange = (patch: AppSettingsPatch, value: AgentAccessLevel, successMessage: string) => {
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
    const updatedMessage = translate(nextLocale, "language.updated");
    const successMessage = demoMode
      ? translate(nextLocale, "settings.demo.resetAfterSession", { message: updatedMessage })
      : updatedMessage;
    void applyOptimisticSettings({ locale: nextLocale }, successMessage, true);
  };

  const choosePreset = (preset: Exclude<BackgroundPreset, "custom">) => {
    void applyOptimisticSettings({ backgroundPreset: preset }, t("settings.background.updated"));
  };

  const commitIntensity = () => {
    if (intensityDraft === currentSettings.backgroundIntensity || busyAction) return;
    void applyOptimisticSettings({ backgroundIntensity: intensityDraft }, t("settings.background.intensityUpdated"));
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
      void applyOptimisticSettings({ backgroundPreset: "custom" }, t("settings.background.customSelected"));
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
          <button className="icon-button" type="button" aria-label={t("settings.close")} data-tooltip={t("settings.close")} disabled={controlsBusy} onClick={requestClose}>
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

            <section className="settings-section" data-settings-nav="appearance" aria-labelledby="appearance-settings">
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
                    onClick={() => void applyOptimisticSettings({ theme: option.value }, t("settings.theme.updated"))}
                  >
                    <ThemeIcon value={option.value} />
                    <span><strong>{t(option.labelKey)}</strong><small>{t(option.detailKey)}</small></span>
                    {currentSettings.theme === option.value && <Check className="option-check" size={15} />}
                  </button>
                ))}
              </div>

              <label className="setting-select-row" htmlFor="list-density">
                <span><strong>{t("settings.density.title")}</strong><small>{t("settings.density.description")}</small></span>
                <ThemedSelect
                  id="list-density"
                  value={currentSettings.listDensity}
                  aria-label={t("settings.density.title")}
                  disabled={controlsBusy}
                  onValueChange={(value) => void applyOptimisticSettings({ listDensity: value as ListDensity }, t("settings.density.updated"))}
                >
                  {listDensityOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </ThemedSelect>
              </label>

              <Switch
                checked={currentSettings.avatarGravatarEnabled}
                disabled={controlsBusy}
                label={t("settings.avatars.gravatar.label")}
                description={t("settings.avatars.gravatar.description")}
                onChange={() => void applyOptimisticSettings({ avatarGravatarEnabled: !currentSettings.avatarGravatarEnabled }, currentSettings.avatarGravatarEnabled ? t("settings.avatars.gravatar.disabled") : t("settings.avatars.gravatar.enabled"))}
              />

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
                    <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("clear-background"); }}>
                      {busyAction === "background-remove" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                      {t("settings.background.clear")}
                    </button>
                  )}
                </div>
              </div>
              <p className="background-upload-hint">{t("settings.background.uploadHint")}</p>
            </section>

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
                onChange={() => void applyOptimisticSettings({ notificationsEnabled: !currentSettings.notificationsEnabled }, currentSettings.notificationsEnabled ? t("settings.notifications.desktop.disabled") : t("settings.notifications.desktop.enabled"))}
              />
              <Switch
                checked={currentSettings.notifyWhenFocused}
                disabled={controlsBusy || !currentSettings.notificationsEnabled}
                label={t("settings.notifications.focused.label")}
                description={t("settings.notifications.focused.description")}
                onChange={() => void applyOptimisticSettings({ notifyWhenFocused: !currentSettings.notifyWhenFocused }, currentSettings.notifyWhenFocused ? t("settings.notifications.focused.disabled") : t("settings.notifications.focused.enabled"))}
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
                    onClick={() => void applyOptimisticSettings({ notificationSound: option.value }, t("settings.sound.updated"))}
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
                      onClick={() => void applyOptimisticSettings({ closeBehavior: option.value }, t("settings.closeBehavior.updated"))}
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
                  onValueChange={(value) => void applyOptimisticSettings({ refreshIntervalSeconds: Number(value) as AppSettings["refreshIntervalSeconds"] }, t("settings.sync.refresh.updated"))}
                >
                  <option value={30}>{t("settings.sync.refresh.thirtySeconds")}</option>
                  <option value={60}>{t("settings.sync.refresh.oneMinute")}</option>
                  <option value={180}>{t("settings.sync.refresh.threeMinutes")}</option>
                  <option value={300}>{t("settings.sync.refresh.fiveMinutes")}</option>
                </ThemedSelect>
              </label>
              <Switch
                checked={currentSettings.realtimePushEnabled}
                disabled={controlsBusy}
                label={t("settings.sync.realtime.label")}
                description={t("settings.sync.realtime.description")}
                onChange={() => void applyOptimisticSettings({ realtimePushEnabled: !currentSettings.realtimePushEnabled }, currentSettings.realtimePushEnabled ? t("settings.sync.realtime.disabled") : t("settings.sync.realtime.enabled"))}
              />
            </section>

            <FilterRulesSection accounts={accounts} demoMode={demoMode} />

            <section className="settings-section" data-settings-nav="agent" aria-labelledby="agent-settings">
              <div className="settings-section-title">
                <Bot size={16} />
                <div><span>{t("agent.launch")}</span><p id="agent-settings">{demoMode ? t("agent.demo.description") : t("agent.providers.description")}</p></div>
              </div>
              {demoMode ? (
                <p className="settings-empty" role="status">{t("agent.demo.actionUnavailable")}</p>
              ) : (
                <>
                  <div className="setting-row agent-provider-settings-row">
                    <div>
                      <strong>{t("agent.providers.title")}</strong>
                      <span>{t("agent.providers.emptyDescription")}</span>
                    </div>
                    <button className="secondary-button" type="button" disabled={controlsBusy} onClick={requestAgentProviderSettings}>
                      <Wrench size={15} />{t("agent.providers.configure")}
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>{t("settings.agent.toolRoundLimit")}</strong>
                      <span>{t("settings.agent.toolRoundLimitDesc")}</span>
                    </div>
                    <NumberStepper
                      value={currentSettings.agentToolRoundLimit}
                      min={1}
                      max={50}
                      disabled={controlsBusy}
                      decreaseLabel={t("settings.agent.toolRoundLimitDecrease")}
                      increaseLabel={t("settings.agent.toolRoundLimitIncrease")}
                      onChange={(value) => void applyOptimisticSettings({ agentToolRoundLimit: value }, t("settings.agent.toolRoundLimitUpdated"))}
                    />
                  </div>
                  <div className="setting-subheading"><span>{t("settings.agent.autoReplyGroup")}</span><small>{t("settings.agent.autoReplyGroupDesc")}</small></div>
                  <Switch
                    checked={currentSettings.autoReply.enabled}
                    disabled={controlsBusy}
                        label={t("settings.agent.autoReplyEnabled")}
                        description={t("settings.agent.autoReplyEnabledDesc")}
                        onChange={() => void applyOptimisticSettings(
                          { autoReply: { ...currentSettings.autoReply, enabled: !currentSettings.autoReply.enabled } },
                          currentSettings.autoReply.enabled ? t("settings.agent.autoReplyDisabled") : t("settings.agent.autoReplyEnabledSaved"),
                        )}
                      />
                      {currentSettings.autoReply.enabled && (
                        <>
                          <div className="setting-row setting-column-row">
                            <div>
                              <strong>{t("settings.agent.autoReplyAccounts")}</strong>
                              <span>{t("settings.agent.autoReplyAccountsDesc")}</span>
                            </div>
                            <div className="auto-reply-account-list" role="group" aria-label={t("settings.agent.autoReplyAccounts")}>
                              {accounts.length === 0 && <p className="settings-empty">{t("settings.agent.autoReplyNoAccounts")}</p>}
                              {accounts.map((account) => {
                                const checked = currentSettings.autoReply.accountIds.includes(account.id);
                                return (
                                  <label className="accounts-row-check" key={account.id}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={controlsBusy}
                                      onChange={() => {
                                        const accountIds = checked
                                          ? currentSettings.autoReply.accountIds.filter((id) => id !== account.id)
                                          : [...currentSettings.autoReply.accountIds, account.id];
                                        void applyOptimisticSettings({ autoReply: { ...currentSettings.autoReply, accountIds } }, t("settings.agent.autoReplyUpdated"));
                                      }}
                                      aria-label={t("settings.agent.autoReplyAccountAriaLabel", { email: account.email })}
                                    />
                                    {account.email}
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                          <div className="setting-row setting-column-row">
                            <div>
                              <strong>{t("settings.agent.autoReplyMode")}</strong>
                              <span>{t("settings.agent.autoReplyModeDesc")}</span>
                            </div>
                            <div className="auto-reply-mode-toggle" role="group" aria-label={t("settings.agent.autoReplyMode")}>
                              <button
                                className={`secondary-button${currentSettings.autoReply.mode === "llm" ? " active" : ""}`}
                                type="button"
                                disabled={controlsBusy}
                                onClick={() => void applyOptimisticSettings(
                                  { autoReply: { ...currentSettings.autoReply, mode: "llm" } },
                                  t("settings.agent.autoReplyUpdated"),
                                )}
                              >
                                {t("settings.agent.autoReplyModeLlm")}
                              </button>
                              <button
                                className={`secondary-button${currentSettings.autoReply.mode === "template" ? " active" : ""}`}
                                type="button"
                                disabled={controlsBusy}
                                onClick={() => void applyOptimisticSettings(
                                  { autoReply: { ...currentSettings.autoReply, mode: "template" } },
                                  t("settings.agent.autoReplyUpdated"),
                                )}
                              >
                                {t("settings.agent.autoReplyModeTemplate")}
                              </button>
                            </div>
                          </div>
                          {currentSettings.autoReply.mode === "template" && (
                            <>
                              <div className="setting-row setting-column-row">
                                <div>
                                  <strong>{t("settings.agent.autoReplyTemplate")}</strong>
                                  <span>{t("settings.agent.autoReplyTemplateDesc")}</span>
                                </div>
                                <textarea
                                  className="auto-reply-template-input"
                                  value={currentSettings.autoReply.template.text}
                                  rows={5}
                                  maxLength={2000}
                                  disabled={controlsBusy}
                                  placeholder={t("settings.agent.autoReplyTemplatePlaceholder")}
                                  aria-label={t("settings.agent.autoReplyTemplate")}
                                  onChange={(event) => void applyOptimisticSettings(
                                    { autoReply: { ...currentSettings.autoReply, template: { ...currentSettings.autoReply.template, text: event.target.value } } },
                                    t("settings.agent.autoReplyUpdated"),
                                  )}
                                />
                                <p className="auto-reply-template-hint">{t("settings.agent.autoReplyTemplateHint")}</p>
                              </div>
                              <Switch
                                checked={currentSettings.autoReply.template.skipConfirmation}
                                disabled={controlsBusy}
                                label={t("settings.agent.autoReplySkipConfirmation")}
                                description={t("settings.agent.autoReplySkipConfirmationDesc")}
                                onChange={() => void applyOptimisticSettings(
                                  { autoReply: { ...currentSettings.autoReply, template: { ...currentSettings.autoReply.template, skipConfirmation: !currentSettings.autoReply.template.skipConfirmation } } },
                                  t("settings.agent.autoReplyUpdated"),
                                )}
                              />
                            </>
                          )}
                          <AutoReplyScopeEditor
                            scope={currentSettings.autoReply.scope}
                            disabled={controlsBusy}
                            onChange={(scope) => void applyOptimisticSettings(
                              { autoReply: { ...currentSettings.autoReply, scope } },
                              t("settings.agent.autoReplyUpdated"),
                            )}
                          />
                          <div className="setting-row">
                            <div>
                              <strong>{t("settings.agent.autoReplyDailyLimit")}</strong>
                              <span>{t("settings.agent.autoReplyDailyLimitDesc")}</span>
                            </div>
                            <NumberStepper
                              value={currentSettings.autoReply.dailyLimitPerAccount}
                              min={0}
                              max={500}
                              disabled={controlsBusy}
                              decreaseLabel={t("settings.agent.autoReplyDailyLimitDecrease")}
                              increaseLabel={t("settings.agent.autoReplyDailyLimitIncrease")}
                              onChange={(value) => void applyOptimisticSettings(
                                { autoReply: { ...currentSettings.autoReply, dailyLimitPerAccount: value } },
                                t("settings.agent.autoReplyUpdated"),
                              )}
                            />
                          </div>
                        </>
                      )}
                      <div className="setting-row agent-tools-row">
                        <div>
                          <strong>{t("settings.agent.autoReplyTools")}</strong>
                          <span>{t("settings.agent.autoReplyToolsDesc")}</span>
                        </div>
                        <div className="agent-tools-actions">
                          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setAutoReplyDialogOpen(true)}>
                            <MessageSquareReply size={15} />{t("settings.agent.autoReplyToolsPending")}
                          </button>
                          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setAutoReplyDecisionsOpen(true)}>
                            <MessageSquareX size={15} />{t("settings.agent.autoReplyToolsDeclined")}
                          </button>
                          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setMemoryDialogOpen(true)}>
                            <BookOpen size={15} />{t("settings.agent.autoReplyToolsMemory")}
                          </button>
                        </div>
                      </div>
                </>
              )}
              <div className="setting-subheading"><span>{t("settings.agent.accessLevelGroup")}</span><small>{t("settings.agent.accessLevelGroupDesc")}</small></div>
              <label className="setting-select-row" htmlFor="agent-access-level">
                <span><strong>{t("settings.agent.builtinAccessLevel")}</strong><small>{t("settings.agent.builtinAccessLevelDesc")}</small></span>
                <ThemedSelect
                  id="agent-access-level"
                  value={currentSettings.agentAccessLevel}
                  aria-label={t("settings.agent.builtinAccessLevel")}
                  disabled={controlsBusy}
                  onValueChange={(value) => requestAccessLevelChange({ agentAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, t("settings.agent.accessLevelUpdated"))}
                >
                  {agentAccessLevelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </ThemedSelect>
              </label>
              <label className="setting-select-row" htmlFor="agent-cli-access-level">
                <span><strong>{t("settings.agent.cliAccessLevel")}</strong><small>{t("settings.agent.cliAccessLevelDesc")}</small></span>
                <ThemedSelect
                  id="agent-cli-access-level"
                  value={currentSettings.agentCliAccessLevel}
                  aria-label={t("settings.agent.cliAccessLevel")}
                  disabled={controlsBusy}
                  onValueChange={(value) => requestAccessLevelChange({ agentCliAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, t("settings.agent.accessLevelUpdated"))}
                >
                  {agentAccessLevelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </ThemedSelect>
              </label>
              <label className="setting-select-row" htmlFor="agent-mcp-access-level">
                <span><strong>{t("settings.agent.mcpAccessLevel")}</strong><small>{t("settings.agent.mcpAccessLevelDesc")}</small></span>
                <ThemedSelect
                  id="agent-mcp-access-level"
                  value={currentSettings.agentMcpAccessLevel}
                  aria-label={t("settings.agent.mcpAccessLevel")}
                  disabled={controlsBusy}
                  onValueChange={(value) => requestAccessLevelChange({ agentMcpAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, t("settings.agent.accessLevelUpdated"))}
                >
                  {agentAccessLevelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </ThemedSelect>
              </label>
              <div className="setting-subheading"><span>{t("settings.agent.externalGuide.title")}</span><small>{t("settings.agent.externalGuide.desc")}</small></div>
              <div className="external-guide">
                <p className="external-guide-note">{t("settings.agent.externalGuide.steps.intro")}</p>
                <ol className="external-guide-steps">
                  <li>{t("settings.agent.externalGuide.steps.1")}</li>
                  <li>{t("settings.agent.externalGuide.steps.2")} <code>namimail service start</code></li>
                  <li>{t("settings.agent.externalGuide.steps.3")}</li>
                  <li>{t("settings.agent.externalGuide.steps.4")}</li>
                </ol>
                <ExternalGuideBlock
                  id="cli"
                  label={t("settings.agent.externalGuide.cli.label")}
                  hint={t("settings.agent.externalGuide.cli.hint", { cmd: "namimail accounts list" })}
                  code={externalCliGuideCode}
                  copiedId={externalGuideCopied}
                  onCopy={copyExternalGuide}
                />
                <ExternalGuideBlock
                  id="mcp"
                  label={t("settings.agent.externalGuide.mcp.label")}
                  hint={t("settings.agent.externalGuide.mcp.hint")}
                  code={externalMcpGuideCode}
                  copiedId={externalGuideCopied}
                  onCopy={copyExternalGuide}
                />
                <ExternalGuideBlock
                  id="service"
                  label={t("settings.agent.externalGuide.service.label")}
                  hint={t("settings.agent.externalGuide.service.hint")}
                  code={externalServiceGuideCode}
                  copiedId={externalGuideCopied}
                  onCopy={copyExternalGuide}
                />
                <p className="external-guide-docs">{t("settings.agent.externalGuide.docs")}<a href={externalDocsUrl} target="_blank" rel="noopener noreferrer">github.com/QinIndexCode/nami-mail</a></p>
              </div>
              <div className="setting-subheading">
                <span>{t("settings.agent.externalPairings.title")}</span>
                <small>{t("settings.agent.externalPairings.desc")}</small>
              </div>
              <div className="external-pairings">
                {externalPairingsError ? (
                  <p className="external-pairings-empty">{t("settings.agent.externalPairings.loadError")}</p>
                ) : externalPairings === null ? (
                  <p className="external-pairings-empty" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" />{t("common.loading")}</p>
                ) : externalPairings.length === 0 ? (
                  <p className="external-pairings-empty">{t("settings.agent.externalPairings.empty", { cmd: "namimail pair" })}</p>
                ) : (
                  <ul className="external-pairings-list">
                    {externalPairings.map((pairing) => {
                      const currentIds = new Set(accounts.map((account) => account.id));
                      const drifted = pairing.status === "active"
                        && (pairing.accountIds.length !== currentIds.size || pairing.accountIds.some((id) => !currentIds.has(id)));
                      return (
                        <li key={pairing.clientId} className={`external-pairing-row external-pairing-${pairing.status}`}>
                          <span className="external-pairing-id" title={pairing.clientId}>{pairing.clientId.slice(0, 20)}</span>
                          <span className="external-pairing-meta">
                            {t("settings.agent.externalPairings.created", { date: formatDate(pairing.createdAt) })}
                            {pairing.expiresAt ? ` · ${t("settings.agent.externalPairings.expires", { date: formatDate(pairing.expiresAt) })}` : ""}
                            {` · ${t("settings.agent.externalPairings.accountCount", { count: pairing.accountIds.length })}`}
                          </span>
                          <span className="external-pairing-status">{t(`settings.agent.externalPairings.status.${pairing.status}`)}</span>
                          {drifted ? <span className="external-pairing-drift">{t("settings.agent.externalPairings.drift")}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <button
                className="secondary-button external-pairings-refresh"
                type="button"
                onClick={() => setExternalPairingsReload((value) => value + 1)}
              >
                {t("settings.agent.externalPairings.refresh")}
              </button>
            </section>

            <section className="settings-section" data-settings-nav="translation" aria-labelledby="translation-settings">
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
                  <div className="translation-provider-picker">
                    <div className="translation-provider-column">
                      <span className="translation-provider-role">{t("settings.translation.primary")}</span>
                      <div className="translation-provider-options" role="radiogroup" aria-label={t("settings.translation.primary")}>
                        {translationConfiguration.providers.map((provider) => (
                          <button
                            key={provider.id}
                            type="button"
                            role="radio"
                            aria-checked={translationPrimary === provider.id}
                            className={`translation-provider-option${translationPrimary === provider.id ? " active" : ""}`}
                            disabled={controlsBusy || (provider.id === "custom" && !provider.endpoint)}
                            onClick={() => setTranslationPrimary(provider.id)}
                          >
                            {provider.builtin ? <Globe size={14} /> : <Server size={14} />}
                            <span>{t(`settings.translation.provider.${provider.id}`)}</span>
                            {translationPrimary === provider.id && <Check size={13} className="translation-provider-check" />}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="translation-provider-column">
                      <span className="translation-provider-role">{t("settings.translation.backup")}</span>
                      <div className="translation-provider-options" role="radiogroup" aria-label={t("settings.translation.backup")}>
                        {translationConfiguration.providers.map((provider) => (
                          <button
                            key={provider.id}
                            type="button"
                            role="radio"
                            aria-checked={translationBackup === provider.id}
                            className={`translation-provider-option${translationBackup === provider.id ? " active" : ""}`}
                            disabled={controlsBusy || provider.id === translationPrimary || (provider.id === "custom" && !provider.endpoint)}
                            onClick={() => setTranslationBackup(provider.id)}
                          >
                            {provider.builtin ? <Globe size={14} /> : <Server size={14} />}
                            <span>{t(`settings.translation.provider.${provider.id}`)}</span>
                            {translationBackup === provider.id && <Check size={13} className="translation-provider-check" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
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
                      <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("remove-translation-api-key"); }}>
                        <KeyRound size={15} />{t("settings.translation.removeKey")}
                      </button>
                    )}
                    {translationConfiguration.source === "local" && (
                      <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("remove-translation-configuration"); }}>
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
          </div>
        </div>

        <footer className="settings-footer">
          <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingConfirmation("restore-defaults"); }}>
            {busyAction === "restore-defaults" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{t("settings.defaults.restore")}
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
