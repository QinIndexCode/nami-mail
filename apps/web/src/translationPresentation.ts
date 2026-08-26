import { ApiError, type TranslationConfiguration, type TranslationProviderId } from "./api";
import type { Translate } from "./i18n";
import { colorLuminance, mailBackgroundColor } from "./mailHtmlTheme";

/** Visual characteristics of the original message body, extracted from the
 *  provider-authored HTML so the translated result can keep the mail's branded
 *  backdrop instead of falling back to a plain app panel. */
export type MailVisualStyle = {
  background: string;
  color?: string;
  fontFamily?: string;
  fontSize?: string;
};

const TAG_PATTERN = /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*\/?>/g;

function attributeOf(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = attrs.match(pattern);
  return match ? (match[2] ?? match[3] ?? "").trim() : null;
}

function inlineStyleOf(attrs: string, property: string): string | null {
  const style = attributeOf(attrs, "style");
  if (!style) return null;
  for (const declaration of style.split(";")) {
    const [name, ...rest] = declaration.trim().split(":");
    if (name?.trim().toLowerCase() === property) return rest.join(":").trim() || null;
  }
  return null;
}

function firstInlineValue(html: string, property: string): string | null {
  for (const match of html.matchAll(TAG_PATTERN)) {
    const value = inlineStyleOf(match[2] ?? "", property);
    if (value) return value;
  }
  return null;
}

function declaredBackgroundOf(attrs: string, tag: string): string | null {
  // Legacy HTML mail frames the message with bgcolor / background attributes
  // on body, tables, and cells, so those count as backdrop declarations too.
  const legacy = ["body", "html", "table", "td", "div"].includes(tag)
    ? attributeOf(attrs, "bgcolor") ?? attributeOf(attrs, "background")
    : null;
  return mailBackgroundColor(
    inlineStyleOf(attrs, "background-color"),
    inlineStyleOf(attrs, "background"),
    legacy,
  );
}

/**
 * Finds the outermost element that declares an opaque backdrop (the mail
 * provider's branded canvas) and returns its visual characteristics. Falls
 * back to a readable foreground when the backdrop is dark but no text color
 * was declared. Returns undefined for plain messages without a backdrop.
 */
export function extractMailVisualStyle(html: string): MailVisualStyle | undefined {
  if (!html || !html.includes("<")) return undefined;
  const tags: Array<{ tag: string; attrs: string; offset: number }> = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    const tag = match[1]!.toLowerCase();
    if (tag === "style" || tag === "script") continue;
    tags.push({ tag, attrs: match[2] ?? "", offset: match.index ?? 0 });
  }
  const surfaceIndex = tags.findIndex(({ tag, attrs }) => {
    const background = declaredBackgroundOf(attrs, tag);
    return background !== null && colorLuminance(background) !== null;
  });
  if (surfaceIndex < 0) return undefined;
  const surface = tags[surfaceIndex]!;
  const background = declaredBackgroundOf(surface.attrs, surface.tag)!;

  const luminance = colorLuminance(background);
  const surfaceColor = inlineStyleOf(surface.attrs, "color") ?? attributeOf(surface.attrs, "color");
  const color = surfaceColor ?? (luminance !== null && luminance < 0.35 ? "#f5f5f6" : undefined);

  const remaining = html.slice(surface.offset);
  const style: MailVisualStyle = { background };
  if (color) style.color = color;
  const fontFamily = firstInlineValue(remaining, "font-family");
  if (fontFamily) style.fontFamily = fontFamily;
  const fontSize = firstInlineValue(remaining, "font-size");
  if (fontSize) style.fontSize = fontSize;
  return style;
}

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
    case "translation_model_download_failed":
      return t("translation.error.modelDownloadFailed");
    case "translation_model_cache_unavailable":
      return t("translation.error.modelCacheUnavailable");
    case "translation_model_unavailable":
      return t("translation.error.modelUnavailable");
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

// Error codes that originate from request validation or message state and are
// therefore shared between the free translation path and the LLM fallback.
const sharedTranslationErrorCodes = new Set([
  "translation_invalid_target",
  "translation_content_unavailable",
  "local_service_unavailable",
]);

/**
 * Maps LLM translation failures to user-facing copy. Reuses the shared
 * validation/state messages when applicable, otherwise surfaces a dedicated
 * AI-translation message so the user can distinguish the failure source.
 */
export function llmTranslationErrorMessage(error: unknown, t: Translate): string {
  const code = translationErrorCode(error);
  if (code && sharedTranslationErrorCodes.has(code)) {
    return translationErrorMessage(error, t);
  }
  if (code === "CLOUD_CONTENT_CONSENT_REQUIRED") {
    return t("translation.llmCloudConsent");
  }
  if (code === "translation_request_too_large") {
    return t("translation.error.requestTooLarge");
  }
  return t("translation.llmError");
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
  primary?: TranslationProviderId;
  backup?: TranslationProviderId;
};

/** Detects unsaved fields without comparing an API key that is deliberately never returned. */
export function hasUnsavedTranslationConfiguration(
  configuration: TranslationConfiguration | null,
  draft: TranslationConfigurationDraft,
): boolean {
  if (!configuration) return false;
  return draft.endpoint.trim() !== configuration.endpoint
    || Boolean(draft.apiKey.trim())
    || draft.timeoutMs !== configuration.timeoutMs
    || (draft.primary ?? "google") !== (configuration.primary ?? "google")
    || (draft.backup ?? "mymemory") !== (configuration.backup ?? "mymemory");
}
