import { isIP } from "node:net";
import { mailErrorCode } from "./mail.js";

export const MAX_TRANSLATION_TEXT_LENGTH = 50_000;
export const MAX_TRANSLATION_RESPONSE_BYTES = 256_000;

export type TranslationServiceErrorCode =
  | "translation_not_configured"
  | "translation_invalid_target"
  | "translation_content_unavailable"
  | "translation_request_too_large"
  | "translation_timeout"
  | "translation_tls_certificate_failed"
  | "translation_tls_handshake_failed"
  | "translation_server_not_found"
  | "translation_network_unavailable"
  | "translation_connection_refused"
  | "translation_connection_failed"
  | "translation_service_authentication_failed"
  | "translation_rate_limited"
  | "translation_service_unavailable"
  | "translation_service_rejected"
  | "translation_invalid_response"
  | "translation_response_too_large";

export class TranslationServiceError extends Error {
  constructor(readonly code: TranslationServiceErrorCode, message: string) {
    super(message);
    this.name = "TranslationServiceError";
  }
}

export type TranslationResult = {
  translatedText: string;
  detectedLanguage?: string;
};

export type TranslationServiceOptions = {
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
};

type TranslationResponse = {
  translatedText?: unknown;
  detectedLanguage?: { language?: unknown };
};

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return Number(normalized.split(".", 1)[0]) === 127;
}

function translationEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TranslationServiceError("translation_not_configured", "The translation endpoint is invalid.");
  }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHost(endpoint.hostname))) {
    throw new TranslationServiceError("translation_not_configured", "The translation endpoint must use HTTPS or local loopback HTTP.");
  }
  if (endpoint.username || endpoint.password || !endpoint.hostname || endpoint.pathname !== "/translate" || endpoint.search || endpoint.hash) {
    throw new TranslationServiceError("translation_not_configured", "The translation endpoint must be a plain /translate URL.");
  }
  return endpoint;
}

export function translationLanguageForLocale(locale: string): string {
  const language = locale.split("-", 1)[0]?.toLowerCase();
  if (!language || !/^[a-z]{2,3}$/.test(language)) {
    throw new TranslationServiceError("translation_invalid_target", "The translation target language is invalid.");
  }
  return language;
}

export function translationErrorStatus(error: TranslationServiceError): number {
  switch (error.code) {
    case "translation_request_too_large":
      return 413;
    case "translation_content_unavailable":
      return 422;
    case "translation_invalid_target":
      return 400;
    case "translation_not_configured":
      return 503;
    case "translation_timeout":
      return 504;
    case "translation_tls_certificate_failed":
    case "translation_tls_handshake_failed":
    case "translation_server_not_found":
    case "translation_network_unavailable":
    case "translation_connection_refused":
    case "translation_connection_failed":
    case "translation_service_authentication_failed":
    case "translation_rate_limited":
    case "translation_service_unavailable":
    case "translation_service_rejected":
    case "translation_invalid_response":
    case "translation_response_too_large":
      return 502;
  }
}

function declaredResponseSize(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function translationResponsePayload(response: Response, abortSignal: AbortSignal): Promise<TranslationResponse | undefined> {
  const declaredSize = declaredResponseSize(response);
  if (declaredSize !== undefined && declaredSize > MAX_TRANSLATION_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new TranslationServiceError("translation_response_too_large", "The translation service response is too large.");
  }
  if (abortSignal.aborted) {
    await cancelResponseBody(response);
    throw abortError();
  }

  const reader = response.body?.getReader();
  if (!reader) throw new TranslationServiceError("translation_invalid_response", "The translation service returned no response body.");
  const cancelReaderForAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  abortSignal.addEventListener("abort", cancelReaderForAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (abortSignal.aborted) throw abortError();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_TRANSLATION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TranslationServiceError("translation_response_too_large", "The translation service response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    abortSignal.removeEventListener("abort", cancelReaderForAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as TranslationResponse;
  } catch {
    return undefined;
  }
}

function detectedLanguageValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(normalized) ? normalized : undefined;
}

function translationTransportErrorCode(error: unknown): TranslationServiceErrorCode | undefined {
  switch (mailErrorCode(error)) {
    case "tls_certificate_failed":
      return "translation_tls_certificate_failed";
    case "tls_handshake_failed":
      return "translation_tls_handshake_failed";
    case "server_not_found":
      return "translation_server_not_found";
    case "network_unavailable":
      return "translation_network_unavailable";
    case "connection_refused":
      return "translation_connection_refused";
    case "connection_failed":
      return "translation_connection_failed";
    case "timeout":
      return "translation_timeout";
    default:
      return undefined;
  }
}

function translationHttpErrorCode(status: number): TranslationServiceErrorCode {
  if (status === 401 || status === 403 || status === 407) return "translation_service_authentication_failed";
  if (status === 429) return "translation_rate_limited";
  if (status >= 500) return "translation_service_unavailable";
  return "translation_service_rejected";
}

export class TranslationService {
  private readonly endpoint: URL | undefined;
  private readonly configurationError: TranslationServiceError | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TranslationServiceOptions = {}) {
    this.timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 25_000));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiKey = options.apiKey?.trim() || undefined;
    if (!options.endpoint?.trim()) return;
    try {
      this.endpoint = translationEndpoint(options.endpoint.trim());
    } catch (error) {
      this.configurationError = error instanceof TranslationServiceError
        ? error
        : new TranslationServiceError("translation_not_configured", "The translation endpoint is invalid.");
    }
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint);
  }

  /** Returns a safe validation issue without exposing endpoint credentials. */
  configurationIssue(): TranslationServiceError | undefined {
    return this.configurationError;
  }

  async translate(text: string, targetLocale: string, shutdownSignal?: AbortSignal): Promise<TranslationResult> {
    if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
      throw new TranslationServiceError("translation_request_too_large", "The message is too large to translate.");
    }
    if (!text.trim()) {
      throw new TranslationServiceError("translation_content_unavailable", "The message does not contain translatable text.");
    }
    if (!this.endpoint) {
      throw this.configurationError ?? new TranslationServiceError("translation_not_configured", "No translation service is configured.");
    }

    const controller = new AbortController();
    let interruptedForShutdown = false;
    const abortForShutdown = () => {
      interruptedForShutdown = true;
      controller.abort();
    };
    if (shutdownSignal?.aborted) abortForShutdown();
    else shutdownSignal?.addEventListener("abort", abortForShutdown, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (interruptedForShutdown) {
        throw new TranslationServiceError("translation_service_unavailable", "The translation request was interrupted during shutdown.");
      }
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        // A redirect can change the destination after the endpoint has passed
        // the HTTPS and hostname checks above. Refuse it rather than sending
        // a selected message body or API key to an unverified destination.
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          q: text,
          source: "auto",
          target: translationLanguageForLocale(targetLocale),
          format: "text",
          ...(this.apiKey ? { api_key: this.apiKey } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new TranslationServiceError(translationHttpErrorCode(response.status), "The translation service could not complete the request.");
      }
      const payload = await translationResponsePayload(response, controller.signal);
      const translatedText = typeof payload?.translatedText === "string" ? payload.translatedText.trim() : "";
      if (!translatedText) {
        throw new TranslationServiceError("translation_invalid_response", "The translation service returned no text.");
      }
      if (translatedText.length > MAX_TRANSLATION_TEXT_LENGTH) {
        throw new TranslationServiceError("translation_response_too_large", "The translation service response is too large.");
      }
      const detectedLanguage = detectedLanguageValue(payload?.detectedLanguage?.language);
      return { translatedText, ...(detectedLanguage ? { detectedLanguage } : {}) };
    } catch (error) {
      if (error instanceof TranslationServiceError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        if (interruptedForShutdown) {
          throw new TranslationServiceError("translation_service_unavailable", "The translation request was interrupted during shutdown.");
        }
        throw new TranslationServiceError("translation_timeout", "The translation request timed out.");
      }
      const transportCode = translationTransportErrorCode(error);
      if (transportCode) {
        throw new TranslationServiceError(transportCode, "The translation service connection failed.");
      }
      throw new TranslationServiceError("translation_service_unavailable", "The translation service is unavailable.");
    } finally {
      clearTimeout(timeout);
      shutdownSignal?.removeEventListener("abort", abortForShutdown);
    }
  }
}
