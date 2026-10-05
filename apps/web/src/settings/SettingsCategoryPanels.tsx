import {
  Bell,
  Check,
  CircleHelp,
  Clock3,
  Download,
  Laptop,
  Languages,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { DesktopUpdateSnapshot } from "../desktop";
import type { LocaleMetadata, Translate } from "../i18n";
import ThemedSelect from "../ThemedSelect";
import type { AppSettings, AppSettingsPatch, NotificationSound } from "../types";
import {
  closeBehaviorOptions,
  soundOptions,
  type PendingSettingsConfirmation,
} from "./settings-utils";
import { CloseBehaviorIcon, Switch } from "./SettingsUIComponents";
import type { UpdatePresentation } from "../updatePresentation";

type ApplySettings = (patch: AppSettingsPatch, successMessage: string | null) => Promise<AppSettings | undefined>;

export type SettingsLanguagePanelProps = {
  t: Translate;
  locales: readonly LocaleMetadata[];
  activeLocale: string;
  controlsBusy: boolean;
  changeLocale: (nextLocale: string) => void;
};

export function SettingsLanguagePanel({
  t,
  locales,
  activeLocale,
  controlsBusy,
  changeLocale,
}: SettingsLanguagePanelProps) {
  return (
    <section className="settings-section" data-settings-nav="language" aria-labelledby="language-settings">
      <div className="settings-section-title">
        <Languages size={16} />
        <div><span id="language-settings">{t("language.title")}</span></div>
      </div>
      <label className="setting-select-row" htmlFor="interface-language">
        <span>
          <strong>{t("language.label")}<span className="field-help-icon" data-tooltip={t("settings.language.applyImmediately")} aria-label={t("settings.language.applyImmediately")} tabIndex={0}><CircleHelp size={12} aria-hidden="true" /></span></strong>
        </span>
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
  );
}

export type SettingsNotificationsPanelProps = {
  t: Translate;
  currentSettings: AppSettings;
  controlsBusy: boolean;
  busyAction: string | null;
  applyOptimisticSettings: ApplySettings;
  testNotification: () => Promise<void>;
  previewSound?: (sound: NotificationSound) => void | Promise<void>;
};

export function SettingsNotificationsPanel({
  t,
  currentSettings,
  controlsBusy,
  busyAction,
  applyOptimisticSettings,
  testNotification,
  previewSound,
}: SettingsNotificationsPanelProps) {
  return (
    <section className="settings-section" data-settings-nav="notifications" aria-labelledby="notification-settings">
      <div className="settings-section-title">
        <Bell size={16} />
        <div><span id="notification-settings">{t("settings.notifications.title")}</span></div>
      </div>
      <Switch
        checked={currentSettings.notificationsEnabled}
        disabled={controlsBusy}
        label={t("settings.notifications.desktop.label")}
        onChange={() => void applyOptimisticSettings({ notificationsEnabled: !currentSettings.notificationsEnabled }, null)}
      />
      <Switch
        checked={currentSettings.notifyWhenFocused}
        disabled={controlsBusy || !currentSettings.notificationsEnabled}
        label={t("settings.notifications.focused.label")}
        onChange={() => void applyOptimisticSettings({ notifyWhenFocused: !currentSettings.notifyWhenFocused }, null)}
      />

      <div className={`setting-subheading${currentSettings.notificationsEnabled ? "" : " muted"}`}>
        <span>
          {t("settings.sound.title")}
          {!currentSettings.notificationsEnabled && (
            <span
              className="field-help-icon"
              data-tooltip={t("settings.sound.enableNotificationsFirst")}
              aria-label={t("settings.sound.enableNotificationsFirst")}
              tabIndex={0}
            >
              <CircleHelp size={12} aria-hidden="true" />
            </span>
          )}
        </span>
      </div>
      <div className="settings-option-grid sound-option-grid" role="group" aria-label={t("settings.sound.groupLabel")}>
        {soundOptions.map((option) => (
          <button
            key={option.value}
            className={`settings-option sound-option${currentSettings.notificationSound === option.value ? " active" : ""}`}
            type="button"
            aria-pressed={currentSettings.notificationSound === option.value}
            disabled={controlsBusy || !currentSettings.notificationsEnabled}
            onClick={() => {
              void applyOptimisticSettings({ notificationSound: option.value }, null);
              if (option.value !== "none") {
                void previewSound?.(option.value);
              }
            }}
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
      </div>
    </section>
  );
}

export type SettingsDesktopPanelProps = {
  t: Translate;
  currentSettings: AppSettings;
  controlsBusy: boolean;
  updateControlsBusy: boolean;
  updateStatus: DesktopUpdateSnapshot | null;
  updatePresentation: UpdatePresentation | null;
  updateActionBusy: "check" | "download" | "skip" | "snooze" | "install" | null;
  updateSnoozeMinutes: number;
  setUpdateSnoozeMinutes: React.Dispatch<React.SetStateAction<number>>;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  skipUpdate: () => void;
  snoozeUpdate: () => void;
  applyOptimisticSettings: ApplySettings;
  resetConfirmClosing: () => void;
  setPendingConfirmation: React.Dispatch<React.SetStateAction<PendingSettingsConfirmation | null>>;
};

export function SettingsDesktopPanel({
  t,
  currentSettings,
  controlsBusy,
  updateControlsBusy,
  updateStatus,
  updatePresentation,
  updateActionBusy,
  updateSnoozeMinutes,
  setUpdateSnoozeMinutes,
  checkForUpdates,
  downloadUpdate,
  skipUpdate,
  snoozeUpdate,
  applyOptimisticSettings,
  resetConfirmClosing,
  setPendingConfirmation,
}: SettingsDesktopPanelProps) {
  return (
    <section className="settings-section" data-settings-nav="desktop" aria-labelledby="desktop-settings">
      <div className="settings-section-title">
        <Laptop size={16} />
        <div><span id="desktop-settings">{t("settings.desktop.title")}</span></div>
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
        onChange={() => void applyOptimisticSettings({ launchAtStartup: !currentSettings.launchAtStartup }, null)}
      />
      <Switch
        checked={currentSettings.globalShortcutEnabled}
        disabled={controlsBusy}
        label={t("settings.shortcut.label")}
        tooltip={t("settings.shortcut.description")}
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
  );
}

export type SettingsSyncPanelProps = {
  t: Translate;
  currentSettings: AppSettings;
  controlsBusy: boolean;
  applyOptimisticSettings: ApplySettings;
};

export function SettingsSyncPanel({
  t,
  currentSettings,
  controlsBusy,
  applyOptimisticSettings,
}: SettingsSyncPanelProps) {
  return (
    <section className="settings-section" data-settings-nav="sync" aria-labelledby="sync-settings">
      <div className="settings-section-title">
        <RefreshCw size={16} />
        <div><span id="sync-settings">{t("settings.sync.title")}</span></div>
      </div>
      <label className="setting-select-row" htmlFor="refresh-interval">
        <span><strong>{t("settings.sync.refresh.label")}</strong></span>
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
        <span>
          <strong>{t("settings.sync.limit.label")}<span className="field-help-icon" data-tooltip={t("settings.sync.limit.description")} aria-label={t("settings.sync.limit.description")} tabIndex={0}><CircleHelp size={12} aria-hidden="true" /></span></strong>
        </span>
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
        tooltip={t("settings.sync.realtime.description")}
        onChange={() => void applyOptimisticSettings({ realtimePushEnabled: !currentSettings.realtimePushEnabled }, null)}
      />
    </section>
  );
}
