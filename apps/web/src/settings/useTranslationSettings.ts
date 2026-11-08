import { useEffect, useState } from "react";
import { api, type TranslationConfiguration, type TranslationProviderId } from "../api";
import type { Notice } from "../FormNotice";
import type { Translate } from "../i18n";
import {
  hasUnsavedTranslationConfiguration,
  translationConfigurationErrorMessage,
} from "../translationPresentation";

export type TranslationSettingsOptions = {
  demoMode: boolean;
  /** The modal's single busy slot; every request below claims and releases it. */
  busyAction: string | null;
  setBusyAction: (action: string | null) => void;
  /** A retry must yield to any action already running in the modal. */
  controlsBusy: boolean;
  setNotice: (notice: Notice) => void;
  t: Translate;
  onTranslationConfigurationChanged?: () => void | Promise<void>;
};

/**
 * Translation service state and the save / remove flows that own it.
 *
 * These ten cells, the load effect and four async handlers only ever feed the
 * translation panel, so they live here instead of inside the settings modal.
 * The draft is compared against the last saved configuration to decide whether
 * closing has to ask before discarding edits.
 */
export function useTranslationSettings({
  demoMode,
  busyAction,
  setBusyAction,
  controlsBusy,
  setNotice,
  t,
  onTranslationConfigurationChanged,
}: TranslationSettingsOptions) {
  const [configuration, setConfiguration] = useState<TranslationConfiguration | null>(null);
  const [loading, setLoading] = useState(!demoMode);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(25_000);
  const [primary, setPrimary] = useState<TranslationProviderId>("google");
  const [backup, setBackup] = useState<TranslationProviderId>("mymemory");

  useEffect(() => {
    if (demoMode) {
      setLoading(false);
      setConfiguration(null);
      setError(null);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void api.translationConfiguration().then((next) => {
      if (!active) return;
      setConfiguration(next);
      setEndpoint(next.endpoint);
      setApiKey("");
      setApiKeyVisible(false);
      setTimeoutMs(next.timeoutMs);
      setPrimary(next.primary ?? "google");
      setBackup(next.backup ?? "mymemory");
    }).catch((cause: unknown) => {
      if (!active) return;
      setConfiguration(null);
      setError(cause);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
    // Do not overwrite an unsaved service address, API key, or timeout when
    // the user changes the interface language while this dialog remains open.
  }, [demoMode, loadAttempt]);

  const applyConfiguration = async (
    next: TranslationConfiguration,
    successMessage: string,
    preserveServiceDraft = false,
  ) => {
    setConfiguration(next);
    if (!preserveServiceDraft) {
      setEndpoint(next.endpoint);
      setTimeoutMs(next.timeoutMs);
    }
    setApiKey("");
    setApiKeyVisible(false);
    await onTranslationConfigurationChanged?.();
    setNotice({ kind: "success", message: successMessage });
  };

  const retryLoad = () => {
    if (loading || controlsBusy) return;
    setLoadAttempt((attempt) => attempt + 1);
  };

  const save = async () => {
    if (busyAction || !configuration) return;
    const trimmedEndpoint = endpoint.trim();
    if (!trimmedEndpoint) {
      setNotice({ kind: "error", message: t("settings.translation.endpointRequired") });
      return;
    }
    setBusyAction("translation-configuration");
    setNotice(null);
    try {
      const next = await api.updateTranslationConfiguration({
        endpoint: trimmedEndpoint,
        timeoutMs: Number(timeoutMs),
        primary,
        backup,
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      await applyConfiguration(next, t("settings.translation.saved"));
    } catch (cause) {
      setNotice({ kind: "error", message: translationConfigurationErrorMessage(cause, t) });
    } finally {
      setBusyAction(null);
    }
  };

  const remove = async () => {
    if (busyAction || !configuration) return;
    setBusyAction("translation-configuration-remove");
    setNotice(null);
    try {
      const next = await api.removeTranslationConfiguration();
      await applyConfiguration(next, t("settings.translation.removed"));
    } catch (cause) {
      setNotice({ kind: "error", message: translationConfigurationErrorMessage(cause, t) });
    } finally {
      setBusyAction(null);
    }
  };

  const removeApiKey = async () => {
    if (busyAction || !configuration) return;
    setBusyAction("translation-configuration-remove-key");
    setNotice(null);
    try {
      const next = await api.updateTranslationConfiguration({ clearApiKey: true });
      await applyConfiguration(next, t("settings.translation.keyRemoved"), true);
    } catch (cause) {
      setNotice({ kind: "error", message: translationConfigurationErrorMessage(cause, t) });
    } finally {
      setBusyAction(null);
    }
  };

  const hasUnsavedDraft = hasUnsavedTranslationConfiguration(configuration, {
    endpoint,
    apiKey,
    timeoutMs,
    primary,
    backup,
  });
  const needsReplacementKey = Boolean(
    configuration?.source === "environment"
    && configuration.apiKeyConfigured
    && !apiKey.trim(),
  );
  const apiKeyHint = configuration?.configurationError
    ? t("settings.translation.apiKeyRecoveryHint")
    : configuration?.source === "environment" && configuration.apiKeyConfigured
      ? t("settings.translation.apiKeyEnvironmentHint")
      : configuration?.apiKeyConfigured
        ? t("settings.translation.apiKeyHint")
        : t("settings.translation.apiKeyOptionalHint");

  return {
    translationConfiguration: configuration,
    translationConfigurationLoading: loading,
    translationConfigurationError: error,
    translationEndpoint: endpoint,
    setTranslationEndpoint: setEndpoint,
    translationApiKey: apiKey,
    setTranslationApiKey: setApiKey,
    translationApiKeyVisible: apiKeyVisible,
    setTranslationApiKeyVisible: setApiKeyVisible,
    translationTimeoutMs: timeoutMs,
    setTranslationTimeoutMs: setTimeoutMs,
    translationPrimary: primary,
    setTranslationPrimary: setPrimary,
    translationBackup: backup,
    setTranslationBackup: setBackup,
    hasUnsavedTranslationDraft: hasUnsavedDraft,
    translationConfigurationNeedsReplacementKey: needsReplacementKey,
    translationApiKeyHint: apiKeyHint,
    saveTranslationConfiguration: save,
    retryTranslationConfigurationLoad: retryLoad,
    removeTranslationConfiguration: remove,
    removeTranslationApiKey: removeApiKey,
  };
}
