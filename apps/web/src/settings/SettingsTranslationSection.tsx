import {
  Check,
  CloudCog,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type { TranslationConfiguration, TranslationProviderId } from "../api";
import type { Translate } from "../i18n";
import {
  translationConfigurationErrorMessage,
  translationConfigurationStatusMessage,
} from "../translationPresentation";

export type SettingsTranslationSectionProps = {
  t: Translate;
  controlsBusy: boolean;
  busyAction: string | null;
  demoMode: boolean;
  translationConfiguration: TranslationConfiguration | null;
  translationConfigurationLoading: boolean;
  translationConfigurationError: unknown;
  translationEndpoint: string;
  setTranslationEndpoint: React.Dispatch<React.SetStateAction<string>>;
  translationApiKey: string;
  setTranslationApiKey: React.Dispatch<React.SetStateAction<string>>;
  translationApiKeyVisible: boolean;
  setTranslationApiKeyVisible: React.Dispatch<React.SetStateAction<boolean>>;
  translationTimeoutMs: number;
  setTranslationTimeoutMs: React.Dispatch<React.SetStateAction<number>>;
  translationPrimary: TranslationProviderId;
  setTranslationPrimary: React.Dispatch<React.SetStateAction<TranslationProviderId>>;
  translationBackup: TranslationProviderId;
  setTranslationBackup: React.Dispatch<React.SetStateAction<TranslationProviderId>>;
  translationConfigurationNeedsReplacementKey: boolean;
  translationApiKeyHint: string;
  saveTranslationConfiguration: () => Promise<void>;
  retryTranslationConfigurationLoad: () => void;
  resetConfirmClosing: () => void;
  setPendingConfirmation: React.Dispatch<React.SetStateAction<"clear-background" | "restore-defaults" | "install-update" | "remove-translation-configuration" | "remove-translation-api-key" | "discard-translation-changes" | "discard-translation-changes-and-open-agent" | "enable-full-access" | null>>;
};

export default function SettingsTranslationSection({
  t,
  controlsBusy,
  busyAction,
  demoMode,
  translationConfiguration,
  translationConfigurationLoading,
  translationConfigurationError,
  translationEndpoint,
  setTranslationEndpoint,
  translationApiKey,
  setTranslationApiKey,
  translationApiKeyVisible,
  setTranslationApiKeyVisible,
  translationTimeoutMs,
  setTranslationTimeoutMs,
  translationPrimary,
  setTranslationPrimary,
  translationBackup,
  setTranslationBackup,
  translationConfigurationNeedsReplacementKey,
  translationApiKeyHint,
  saveTranslationConfiguration,
  retryTranslationConfigurationLoad,
  resetConfirmClosing,
  setPendingConfirmation,
}: SettingsTranslationSectionProps) {
  return (
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
                    {provider.builtin ? <Globe size={14} /> : <CloudCog size={14} />}
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
                    {provider.builtin ? <Globe size={14} /> : <CloudCog size={14} />}
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
  );
}
