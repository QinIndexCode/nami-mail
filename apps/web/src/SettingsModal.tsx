import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import {
  Bell,
  Check,
  CircleHelp,
  Clock3,
  Download,
  ImagePlus,
  Laptop,
  LoaderCircle,
  Mail,
  Minimize2,
  Moon,
  Palette,
  Power,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Sun,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api } from "./api";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import { accountHealthIssue, mailErrorMessage } from "./errorPresentation";
import { canPlayCustomNotificationSound, playNotificationSound, primeNotificationSound } from "./sounds";
import ThemedSelect from "./ThemedSelect";
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
  label: string;
  description: string;
  image?: string;
};

export const backgroundPresetOptions: readonly BackgroundPresetOption[] = [
  { id: "none", label: "纯净", description: "保持界面底色" },
  { id: "paper", label: "纸纹", description: "安静、柔和", image: "/backgrounds/paper.png" },
  { id: "mist", label: "薄雾", description: "清晨的灰蓝", image: "/backgrounds/mist.png" },
  { id: "coast", label: "海岸", description: "低饱和的远方", image: "/backgrounds/coast.png" },
  { id: "dawn", label: "破晓", description: "温暖的光线", image: "/backgrounds/dawn.png" },
  { id: "night", label: "夜色", description: "深静的层次", image: "/backgrounds/night.png" },
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
  /** Visible control used only when the original trigger disappears, such as a closed mobile drawer. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Demo settings are intentionally in-memory and are never sent to the local API. */
  demoMode?: boolean;
};

type Notice = { kind: "success" | "error"; message: string } | null;

const restoreDefaultsPatch: AppSettingsPatch = {
  theme: defaultAppSettings.theme,
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

const themeOptions: Array<{ value: AppTheme; label: string; detail: string }> = [
  { value: "system", label: "跟随系统", detail: "随 Windows 外观切换" },
  { value: "light", label: "浅色", detail: "明亮、专注" },
  { value: "dark", label: "深色", detail: "低光环境更舒适" },
];

const soundOptions: Array<{ value: NotificationSound; label: string; detail: string }> = [
  { value: "system", label: "系统默认", detail: "使用 Windows 提醒音" },
  { value: "soft", label: "轻柔", detail: "两声短提示" },
  { value: "bright", label: "明亮", detail: "三声上扬提示" },
  { value: "none", label: "静音", detail: "只显示通知" },
];

const closeBehaviorOptions: Array<{ value: CloseBehavior; label: string; detail: string }> = [
  { value: "ask", label: "每次询问", detail: "关闭窗口时再选择" },
  { value: "tray", label: "最小化到托盘", detail: "继续同步邮件和发送通知" },
  { value: "quit", label: "退出应用", detail: "停止同步并完全退出" },
];

function errorMessage(error: unknown, fallback: string): string {
  return mailErrorMessage(error, fallback);
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
  fallbackFocusRef,
  demoMode = false,
}: SettingsModalProps) {
  const [currentSettings, setCurrentSettings] = useState(settings);
  const [notice, setNotice] = useState<Notice>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [intensityDraft, setIntensityDraft] = useState(settings.backgroundIntensity);
  const [pendingAccountRemoval, setPendingAccountRemoval] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<"clear-background" | "restore-defaults" | "install-update" | null>(null);
  const [backgroundUploadError, setBackgroundUploadError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateSnapshot | null>(null);
  const [updateActionBusy, setUpdateActionBusy] = useState<"check" | "download" | "skip" | "snooze" | "install" | null>(null);
  const [updateSnoozeMinutes, setUpdateSnoozeMinutes] = useState(24 * 60);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const backgroundAlert = useRef<HTMLElement>(null);
  const pendingRemovalAccount = accounts.find((account) => account.id === pendingAccountRemoval) ?? null;

  const dismissBackgroundUploadError = () => {
    setBackgroundUploadError(null);
  };

  const requestClose = () => {
    if (!busyAction) onClose();
  };

  useEffect(() => {
    setCurrentSettings(settings);
  }, [settings]);

  useEffect(() => {
    setIntensityDraft(currentSettings.backgroundIntensity);
  }, [currentSettings.backgroundIntensity]);

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
      if (busyAction) return;
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
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [backgroundUploadError, busyAction, onClose, pendingConfirmation, pendingRemovalAccount]);

  useDialogFocus(true, settingsDialog, { fallbackFocusRef, suspended: Boolean(pendingConfirmation || pendingRemovalAccount || backgroundUploadError) });
  useDialogFocus(Boolean(pendingConfirmation || pendingRemovalAccount), confirmationDialog, { fallbackFocusRef: settingsDialog });
  useDialogFocus(Boolean(backgroundUploadError), backgroundAlert, { restoreFocusRef: uploadButton });

  const publishSettings = async (next: AppSettings): Promise<AppSettings> => {
    setCurrentSettings(next);
    await onSettingsChange(next);
    return next;
  };

  const saveSettings = async (patch: AppSettingsPatch, action: string, successMessage: string): Promise<AppSettings | undefined> => {
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
        message: demoMode ? `${successMessage} 本次演示结束后会恢复。` : successMessage,
      });
      return next;
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, "无法保存设置。") });
      return undefined;
    } finally {
      setBusyAction(null);
    }
  };

  const choosePreset = (preset: Exclude<BackgroundPreset, "custom">) => {
    void saveSettings({ backgroundPreset: preset }, `background-${preset}`, "背景已更新。");
  };

  const commitIntensity = () => {
    if (intensityDraft === currentSettings.backgroundIntensity || busyAction) return;
    void saveSettings({ backgroundIntensity: intensityDraft }, "background-intensity", "背景强度已更新。");
  };

  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busyAction) return;
    const contentType = backgroundContentTypeForFile(file);
    if (!contentType) {
      setBackgroundUploadError(`“${file.name}” 不是受支持的图片。请选择 JPEG、PNG 或 WebP 格式。`);
      return;
    }
    if (file.size > maxBackgroundUploadBytes) {
      setBackgroundUploadError(`“${file.name}” 已超过 50 MB 上传上限。请选择更小的 JPEG、PNG 或 WebP 图片。`);
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
        message: demoMode ? "自定义背景仅用于本次演示。" : "背景已优化并保存在此设备。",
      });
    } catch (error) {
      if (demoObjectUrl && !saved) revokeDemoObjectUrl(demoObjectUrl);
      setBackgroundUploadError(errorMessage(error, "无法保存自定义背景。"));
    } finally {
      setBusyAction(null);
    }
  };

  const chooseCustomBackground = () => {
    if (currentSettings.customBackgroundUrl) {
      void saveSettings({ backgroundPreset: "custom" }, "background-custom", "已切换到自定义背景。");
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
      setNotice({ kind: "success", message: demoMode ? "已清除演示背景。" : "自定义背景已删除。" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, "无法删除自定义背景。") });
    } finally {
      setBusyAction(null);
    }
  };

  const notifyInBrowser = async (silent = currentSettings.notificationSound === "none") => {
    const bridge = desktopBridge();
    if (bridge) {
      await bridge.notify({
        title: "Nami Mail",
        body: "这是一条新邮件提醒测试。",
        silent,
      });
      return;
    }
    if (isDesktopRuntime) throw new Error("桌面通知服务不可用，请重启应用。");
    if (!("Notification" in window)) throw new Error("当前浏览器不支持桌面通知。");
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("请允许 Nami Mail 发送桌面通知。");
    new Notification("Nami Mail", { body: "这是一条新邮件提醒测试。", silent });
  };

  const playSoundTest = async () => {
    if (currentSettings.notificationSound === "none") {
      setNotice({ kind: "success", message: "当前设置为静音，因此不会播放提示音。" });
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
      setNotice({ kind: "success", message: "已发送测试提醒。" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, "无法发送测试提醒。") });
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
      if (currentSettings.notificationSound === "system") setNotice({ kind: "success", message: "系统提醒测试已发送。" });
      else if (currentSettings.notificationSound !== "none") setNotice({ kind: "success", message: "提示音测试已播放。" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, "无法播放提示音。") });
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
      setNotice({ kind: "error", message: updateBridgeErrorMessage(error, "更新操作未完成。请重新检查后再试。") });
    } finally {
      setUpdateActionBusy(null);
    }
  };

  const checkForUpdates = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: "自动更新暂时不可用。请退出后重新打开 Nami Mail，再试一次。" });
      return;
    }
    void runUpdateAction("check", () => bridge.checkForUpdates());
  };

  const downloadUpdate = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: "自动更新暂时不可用。请退出后重新打开 Nami Mail，再试一次。" });
      return;
    }
    void runUpdateAction("download", () => bridge.downloadUpdate());
  };

  const skipUpdate = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: "自动更新暂时不可用。请退出后重新打开 Nami Mail，再试一次。" });
      return;
    }
    void runUpdateAction("skip", () => bridge.skipUpdate());
  };

  const snoozeUpdate = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: "自动更新暂时不可用。请退出后重新打开 Nami Mail，再试一次。" });
      return;
    }
    void runUpdateAction("snooze", () => bridge.snoozeUpdate(updateSnoozeMinutes));
  };

  const installUpdate = async () => {
    if (updateActionBusy) return;
    const bridge = desktopBridge();
    if (!bridge) {
      setNotice({ kind: "error", message: "自动更新暂时不可用。请退出后重新打开 Nami Mail，再试一次。" });
      return;
    }
    setPendingConfirmation(null);
    setUpdateActionBusy("install");
    try {
      const result = await bridge.installUpdate();
      if (!result.accepted) {
        if (result.snapshot) setUpdateStatus(result.snapshot);
        setNotice({ kind: "error", message: "更新尚未准备好安装。请重新检查后再试。" });
      }
    } catch (error) {
      setNotice({ kind: "error", message: updateBridgeErrorMessage(error, "无法开始安装更新。Nami Mail 会继续运行，请重新检查后再试。") });
    } finally {
      setUpdateActionBusy(null);
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
        message: demoMode ? "账户已从本次演示中移除。" : "邮箱账户已从此设备移除。",
      });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, "无法移除邮箱账户。") });
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
        ? `已重新同步 ${account.email}，但仍有 ${result.failedFolders} 个文件夹未完成。`
        : `已重新同步 ${account.email}${result.synced ? `，获取 ${result.synced} 封邮件。` : "。"}`;
      setNotice({ kind: result.failedFolders ? "error" : "success", message: summary });
    } catch (error) {
      setNotice({ kind: "error", message: `${account.email}：${mailErrorMessage(error)}` });
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
      setNotice({ kind: "success", message: demoMode ? "默认设置已应用于本次演示。" : "已恢复默认设置。" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error, "无法恢复默认设置。") });
    } finally {
      setBusyAction(null);
    }
  };

  const hasCustomBackground = Boolean(currentSettings.customBackgroundUrl);
  const controlsBusy = Boolean(busyAction || updateActionBusy === "install");
  const updateControlsBusy = controlsBusy || Boolean(updateActionBusy);
  const dismissConfirmation = () => {
    if (controlsBusy) return;
    setPendingConfirmation(null);
    setPendingAccountRemoval(null);
  };

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section ref={settingsDialog} className="modal-card settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <header className="modal-heading settings-heading">
          <div>
            <span className="eyebrow">偏好设置</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭设置" data-tooltip="关闭设置" disabled={controlsBusy} onClick={requestClose}>
            <X size={18} />
          </button>
        </header>

        {notice && <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}{notice.message}</div>}

        <section className="settings-section" aria-labelledby="appearance-settings">
          <div className="settings-section-title">
            <Palette size={16} />
            <div><span>外观</span><p id="appearance-settings">主题、背景与显示偏好</p></div>
          </div>

          <div className="settings-option-grid theme-option-grid" role="group" aria-label="应用主题">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                className={`settings-option${currentSettings.theme === option.value ? " active" : ""}`}
                type="button"
                aria-pressed={currentSettings.theme === option.value}
                disabled={controlsBusy}
                onClick={() => void saveSettings({ theme: option.value }, `theme-${option.value}`, "主题已更新。")}
              >
                <ThemeIcon value={option.value} />
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                {currentSettings.theme === option.value && <Check className="option-check" size={15} />}
              </button>
            ))}
          </div>

          <div className="setting-subheading"><span>背景</span><small>内置背景可离线使用</small></div>
          <div className="background-preset-grid" role="group" aria-label="背景预设">
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
                  <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
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
              <span><strong>自定义</strong><small>{hasCustomBackground ? (demoMode ? "仅本次演示" : "已保存到此设备") : "使用本地图片"}</small></span>
              {currentSettings.backgroundPreset === "custom" && <Check className="option-check" size={14} />}
            </button>
          </div>
          <input ref={uploadInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadBackground(event)} />

          <div className="background-controls">
            <label className="setting-range" htmlFor="background-intensity">
              <span><strong>背景强度</strong><small>{intensityDraft}%</small></span>
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
                {hasCustomBackground ? "更换图片" : "上传图片"}
              </button>
              {hasCustomBackground && (
                <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => setPendingConfirmation("clear-background")}>
                  {busyAction === "background-remove" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                  清除
                </button>
              )}
            </div>
          </div>
          <p className="background-upload-hint">JPEG、PNG、WebP · 原图最大 50 MB · 会自动处理为本地背景</p>
        </section>

        <section className="settings-section" aria-labelledby="notification-settings">
          <div className="settings-section-title">
            <Bell size={16} />
            <div><span>新邮件提醒</span><p id="notification-settings">这些提醒仅在此设备上生效</p></div>
          </div>
          <Switch
            checked={currentSettings.notificationsEnabled}
            disabled={controlsBusy}
            label="桌面通知"
            description="新邮件到达时显示系统提醒"
            onChange={() => void saveSettings({ notificationsEnabled: !currentSettings.notificationsEnabled }, "notifications", currentSettings.notificationsEnabled ? "已关闭桌面通知。" : "已开启桌面通知。")}
          />
          <Switch
            checked={currentSettings.notifyWhenFocused}
            disabled={controlsBusy || !currentSettings.notificationsEnabled}
            label="使用应用时仍提醒"
            description="正在查看 Nami Mail 时仍显示提醒"
            onChange={() => void saveSettings({ notifyWhenFocused: !currentSettings.notifyWhenFocused }, "notify-focused", currentSettings.notifyWhenFocused ? "已关闭前台提醒。" : "已开启前台提醒。")}
          />

          <div className={`setting-subheading${currentSettings.notificationsEnabled ? "" : " muted"}`}><span>提示音</span><small>{currentSettings.notificationsEnabled ? "选择新邮件到达时的声音" : "先开启桌面通知"}</small></div>
          <div className="settings-option-grid sound-option-grid" role="group" aria-label="通知提示音">
            {soundOptions.map((option) => (
              <button
                key={option.value}
                className={`settings-option sound-option${currentSettings.notificationSound === option.value ? " active" : ""}`}
                type="button"
                aria-pressed={currentSettings.notificationSound === option.value}
                disabled={controlsBusy || !currentSettings.notificationsEnabled}
                onClick={() => void saveSettings({ notificationSound: option.value }, `sound-${option.value}`, "提示音已更新。")}
              >
                {option.value === "none" ? <VolumeX size={16} /> : <Volume2 size={16} />}
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                {currentSettings.notificationSound === option.value && <Check className="option-check" size={15} />}
              </button>
            ))}
          </div>
          <div className="settings-inline-actions">
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void testNotification()}>
              {busyAction === "notification-test" ? <LoaderCircle className="spin" size={15} /> : <Bell size={15} />}测试提醒
            </button>
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void testSound()}>
              {busyAction === "sound-test" ? <LoaderCircle className="spin" size={15} /> : <Volume2 size={15} />}测试声音
            </button>
          </div>
        </section>

        {isDesktopRuntime && (
          <section className="settings-section" aria-labelledby="desktop-settings">
            <div className="settings-section-title">
              <Laptop size={16} />
              <div><span>桌面应用</span><p id="desktop-settings">关闭行为与软件更新</p></div>
            </div>
            <div className="settings-option-grid close-behavior-grid" role="group" aria-label="关闭窗口时">
              {closeBehaviorOptions.map((option) => (
                <button
                  key={option.value}
                  className={`settings-option${currentSettings.closeBehavior === option.value ? " active" : ""}`}
                  type="button"
                  data-close-behavior={option.value}
                  aria-pressed={currentSettings.closeBehavior === option.value}
                  disabled={controlsBusy}
                  onClick={() => void saveSettings({ closeBehavior: option.value }, `close-${option.value}`, "关闭窗口行为已更新。")}
                >
                  <CloseBehaviorIcon value={option.value} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                  {currentSettings.closeBehavior === option.value && <Check className="option-check" size={15} />}
                </button>
              ))}
            </div>
            {updateStatus && (
              <div className="setting-row update-setting-row">
                <div>
                  <strong>{updateStatus.targetVersion ? `软件更新 · v${updateStatus.targetVersion}` : `软件更新 · 当前 v${updateStatus.currentVersion}`}</strong>
                  <span className={updateStatus.phase === "error" ? "account-error" : ""} aria-live="polite">{updateStatus.message}</span>
                  {updateStatus.percent !== null && ["available", "downloading", "ready"].includes(updateStatus.phase) && (
                    <progress aria-label="更新下载进度" max={100} value={updateStatus.percent} />
                  )}
                </div>
                <div className="settings-inline-actions">
                  {updateStatus.phase === "ready" && updateStatus.suppression === "none" ? (
                    <>
                      <button className="primary-button" type="button" disabled={updateControlsBusy} onClick={() => setPendingConfirmation("install-update")}>
                        <RotateCcw size={15} />重启并更新
                      </button>
                      <button className="secondary-button" type="button" disabled={updateControlsBusy} onClick={skipUpdate}>
                        {updateActionBusy === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}跳过此版本
                      </button>
                    </>
                  ) : updateStatus.phase === "available" && updateStatus.suppression === "none" ? (
                    <>
                      <button className="primary-button" type="button" disabled={updateControlsBusy} onClick={downloadUpdate}>
                        {updateActionBusy === "download" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}更新此版本
                      </button>
                      <button className="secondary-button" type="button" disabled={updateControlsBusy} onClick={skipUpdate}>
                        {updateActionBusy === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}跳过此版本
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
                      检查更新
                    </button>
                  ) : null}
                </div>
                {["available", "ready"].includes(updateStatus.phase) && updateStatus.suppression === "none" && (
                  <div className="update-snooze-controls" role="group" aria-label="稍后提醒更新">
                    <span><Clock3 size={14} aria-hidden="true" />稍后提醒</span>
                    <ThemedSelect
                      id="settings-update-snooze"
                      value={updateSnoozeMinutes}
                      aria-label="选择更新提醒时间"
                      disabled={updateControlsBusy}
                      onValueChange={(value) => setUpdateSnoozeMinutes(Number(value))}
                    >
                      <option value={60}>1 小时后提醒</option>
                      <option value={1440}>明天提醒</option>
                      <option value={10080}>一周后提醒</option>
                      <option value={43200}>30 天后提醒</option>
                    </ThemedSelect>
                    <button className="secondary-button" type="button" disabled={updateControlsBusy} onClick={snoozeUpdate}>
                      {updateActionBusy === "snooze" ? <LoaderCircle className="spin" size={15} /> : <Clock3 size={15} />}提醒我
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
            <div><span>同步</span><p id="sync-settings">没有实时推送时检查新邮件的频率</p></div>
          </div>
          <label className="setting-select-row" htmlFor="refresh-interval">
            <span><strong>自动刷新</strong><small>定期检查已连接邮箱中的新邮件</small></span>
            <ThemedSelect
              id="refresh-interval"
              value={currentSettings.refreshIntervalSeconds}
              disabled={controlsBusy}
              onValueChange={(value) => void saveSettings({ refreshIntervalSeconds: Number(value) as AppSettings["refreshIntervalSeconds"] }, "refresh-interval", "自动刷新频率已更新。")}
            >
              <option value={30}>每 30 秒</option>
              <option value={60}>每分钟</option>
              <option value={180}>每 3 分钟</option>
              <option value={300}>每 5 分钟</option>
            </ThemedSelect>
          </label>
        </section>

        <section className="settings-section settings-accounts" aria-labelledby="account-settings">
          <div className="settings-section-title">
            <Mail size={16} />
            <div><span>账户管理</span><p id="account-settings">{demoMode ? "仅影响当前演示，不会连接或删除邮箱数据" : "移除账户会删除此设备中保存的登录凭据和本地邮件缓存"}</p></div>
          </div>
          {accounts.length === 0 ? (
            <p className="settings-empty">还没有连接邮箱账户。</p>
          ) : (
            <div className="settings-account-list">
              {accounts.map((account) => {
                const issue = accountHealthIssue(account);
                const retrying = busyAction === `account-sync-${account.id}`;
                return (
                  <div className="settings-account" key={account.id}>
                    <div className="settings-account-copy">
                      <span className={`status-dot ${issue ? "error" : account.status}`} aria-hidden="true" />
                      <span>
                        <strong>{account.email}</strong>
                        <small className={`${issue ? "account-error " : ""}truncated-tooltip`} data-tooltip={issue ? `${issue.message} ${issue.guidance}` : account.providerName}><span>{issue ? `${account.providerName} · ${issue.title}` : account.providerName}</span></small>
                        {issue && <small className="account-error-guidance">{issue.guidance}</small>}
                      </span>
                    </div>
                    <div className="settings-account-actions">
                      {issue?.retryable && (
                        <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void retryAccount(account)}>
                          {retrying ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重新同步
                        </button>
                      )}
                      <button className="icon-button danger-icon-button" type="button" aria-label={`移除 ${account.email}`} data-tooltip="移除账户" disabled={controlsBusy} onClick={() => setPendingAccountRemoval(account.id)}>
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
            {busyAction === "restore-defaults" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}恢复默认设置
          </button>
          <button className="primary-button" type="button" disabled={controlsBusy} onClick={requestClose}>完成</button>
        </footer>
      </section>
      {(pendingConfirmation || pendingRemovalAccount) && (
        <div className="modal-backdrop confirmation-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && dismissConfirmation()}>
          <section ref={confirmationDialog} className="confirmation-card" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirmation-title" aria-describedby="settings-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">确认操作</span>
            <h3 id="settings-confirmation-title">{pendingRemovalAccount ? `移除 ${pendingRemovalAccount.email}？` : pendingConfirmation === "clear-background" ? "清除自定义背景？" : pendingConfirmation === "install-update" ? "重启并安装更新？" : "恢复默认设置？"}</h3>
            <p id="settings-confirmation-description">
              {pendingRemovalAccount
                ? "这会删除此设备中保存的登录凭据和本地邮件缓存，不会删除邮箱服务器中的邮件。"
                : pendingConfirmation === "clear-background"
                ? "这会删除此设备保存的自定义背景图片，并切换回默认海岸背景。"
                : pendingConfirmation === "install-update"
                ? "Nami Mail 将退出并继续安装已下载的更新。请先保存正在编辑的内容。"
                : "这会重置主题、背景、提醒和同步偏好；自定义背景也会被删除。"}
            </p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={controlsBusy} onClick={dismissConfirmation}>取消</button>
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
                  else void restoreDefaults();
                }}
              >
                {pendingRemovalAccount && busyAction === `account-remove-${pendingRemovalAccount.id}` ? <LoaderCircle className="spin" size={14} /> : pendingRemovalAccount ? <Trash2 size={14} /> : pendingConfirmation === "install-update" ? <RotateCcw size={14} /> : null}
                {pendingRemovalAccount ? "移除账户" : pendingConfirmation === "clear-background" ? "清除背景" : pendingConfirmation === "install-update" ? "重启并更新" : "恢复默认"}
              </button>
            </div>
          </section>
        </div>
      )}
      {backgroundUploadError && (
        <div className="modal-backdrop settings-alert-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && dismissBackgroundUploadError()}>
          <section ref={backgroundAlert} className="settings-alert-card" role="alertdialog" aria-modal="true" aria-labelledby="background-upload-error-title" aria-describedby="background-upload-error-description" tabIndex={-1}>
            <span className="eyebrow">背景图片</span>
            <h3 id="background-upload-error-title">无法使用这张图片</h3>
            <p id="background-upload-error-description">{backgroundUploadError}</p>
            <div className="settings-alert-actions">
              <button className="primary-button" type="button" onClick={dismissBackgroundUploadError}>知道了</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
