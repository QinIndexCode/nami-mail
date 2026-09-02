import { useRef } from "react";
import {
  Check,
  ImagePlus,
  LoaderCircle,
  Palette,
  Trash2,
  Upload,
} from "lucide-react";
import type { ChangeEvent, RefObject } from "react";
import type { BackgroundPreset, ListDensity, AppSettings } from "../types";
import type { Translate } from "../i18n";
import {
  backgroundPresetOptions,
  listDensityOptions,
  themeOptions,
} from "./settings-utils";
import { Switch, ThemeIcon } from "./SettingsUIComponents";
import ThemedSelect from "../ThemedSelect";

export type SettingsAppearanceSectionProps = {
  t: Translate;
  currentSettings: AppSettings;
  controlsBusy: boolean;
  busyAction: string | null;
  demoMode: boolean;
  intensityDraft: number;
  hasCustomBackground: boolean;
  applyOptimisticSettings: (patch: Record<string, unknown>, successMessage: string | null) => Promise<unknown>;
  choosePreset: (preset: Exclude<BackgroundPreset, "custom">) => void;
  setIntensityDraft: React.Dispatch<React.SetStateAction<number>>;
  commitIntensity: () => void;
  chooseCustomBackground: () => void;
  uploadBackground: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  resetConfirmClosing: () => void;
  setPendingConfirmation: React.Dispatch<React.SetStateAction<"clear-background" | "restore-defaults" | "install-update" | "remove-translation-configuration" | "remove-translation-api-key" | "discard-translation-changes" | "discard-translation-changes-and-open-agent" | "enable-full-access" | null>>;
  /** Receives the background upload button so the oversized-file alert can restore focus to it. */
  uploadButtonRef?: RefObject<HTMLButtonElement | null>;
};

export default function SettingsAppearanceSection({
  t,
  currentSettings,
  controlsBusy,
  busyAction,
  demoMode,
  intensityDraft,
  hasCustomBackground,
  applyOptimisticSettings,
  choosePreset,
  setIntensityDraft,
  commitIntensity,
  chooseCustomBackground,
  uploadBackground,
  resetConfirmClosing,
  setPendingConfirmation,
  uploadButtonRef,
}: SettingsAppearanceSectionProps) {
  const uploadInput = useRef<HTMLInputElement>(null);

  return (
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
            onClick={() => void applyOptimisticSettings({ theme: option.value }, null)}
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
          onValueChange={(value) => void applyOptimisticSettings({ listDensity: value as ListDensity }, null)}
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
        onChange={() => void applyOptimisticSettings({ avatarGravatarEnabled: !currentSettings.avatarGravatarEnabled }, null)}
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
          <button ref={uploadButtonRef} className="secondary-button" type="button" disabled={controlsBusy} onClick={() => uploadInput.current?.click()}>
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
  );
}
