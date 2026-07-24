import { ApiError, type TranslationConfiguration } from "./api";
import type { Translate } from "./i18n";

function translationErrorCode(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** Converts stable local API translation errors into user-facing recovery copy. */
export function translationErrorMessage(error: unknown, t: Translate): string {
  switch (translationErrorCode(error)) {
    case "translation_not_configured":
      return t("translation.error.notConfigured");
    case "translation_invalid_target":
      return t("translation.error.invalidTarget");
    case "translation_content_unavailable":
      return t("translation.error.contentUnavailable");
    case "translation_request_too_large":
      return t("translation.error.requestTooLarge");
    case "translation_timeout":
      return t("translation.error.timeout");
    case "translation_tls_certificate_failed":
      return t("translation.error.tlsCertificate");
    case "translation_tls_handshake_failed":
      return t("translation.error.tlsHandshake");
    case "translation_server_not_found":
      return t("translation.error.serverNotFound");
    case "translation_network_unavailable":
      return t("translation.error.networkUnavailable");
    case "translation_connection_refused":
      return t("translation.error.connectionRefused");
    case "translation_connection_failed":
      return t("translation.error.connectionFailed");
    case "translation_service_authentication_failed":
      return t("translation.error.serviceAuthentication");
    case "translation_rate_limited":
      return t("translation.error.rateLimited");
    case "translation_service_unavailable":
      return t("translation.error.serviceUnavailable");
    case "translation_service_rejected":
      return t("translation.error.serviceRejected");
    case "translation_invalid_response":
      return t("translation.error.invalidResponse");
    case "translation_response_too_large":
      return t("translation.error.responseTooLarge");
    case "local_service_unavailable":
      return t("translation.error.localServiceUnavailable");
    default:
      return t("translation.error.failed");
  }
}

/** Keeps configuration failures actionable without exposing local API details. */
export function translationConfigurationErrorMessage(
  error: unknown,
  t: Translate,
  fallbackKey = "settings.translation.saveFailed",
): string {
  switch (translationErrorCode(error)) {
    case "translation_configuration_invalid":
      return t("settings.translation.configurationInvalid");
    case "translation_configuration_managed":
      return t("settings.translation.configurationManaged");
    case "local_service_unavailable":
      return t("translation.error.localServiceUnavailable");
    default:
      return t(fallbackKey);
  }
}

/** Describes a safe configuration summary without exposing the API key. */
export function translationConfigurationStatusMessage(configuration: TranslationConfiguration, t: Translate): string {
  if (configuration.configurationError === "unreadable") {
    return t("settings.translation.configurationUnreadable");
  }
  if (configuration.configurationError === "invalid") {
    return t("settings.translation.configurationInvalid");
  }
  return t(`settings.translation.source.${configuration.source}`);
}

export type TranslationConfigurationDraft = {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
};

/** Detects unsaved fields without comparing an API key that is deliberately never returned. */
export function hasUnsavedTranslationConfiguration(
  configuration: TranslationConfiguration | null,
  draft: TranslationConfigurationDraft,
): boolean {
  if (!configuration) return false;
  return draft.endpoint.trim() !== configuration.endpoint
    || Boolean(draft.apiKey.trim())
    || draft.timeoutMs !== configuration.timeoutMs;
}
