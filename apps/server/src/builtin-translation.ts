import {
  MAX_TRANSLATION_TEXT_LENGTH,
  TranslationService,
  TranslationServiceError,
  type TranslationResult,
  type TranslationServiceOptions,
  translationLanguageForLocale,
} from "./translation.js";

const GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const BUILTIN_TRANSLATION_TIMEOUT_MS = 15_000;
const MYMEMORY_DEFAULT_SOURCE_LANGUAGE = "en";

export type BuiltinTranslationServiceOptions = {
  fetchImpl?: typeof globalThis.fetch;
};

type DetectedLanguageRef = { value?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Google Translate returns a nested array. data[0] is an array of segments,
// where each segment is [translatedText, originalText, null, null, confidence].
// data[2] is the detected source language code.
function extractGoogleTranslation(data: unknown): { translatedText: string; detectedLanguage?: string } {
  if (!Array.isArray(data)) {
    return { translatedText: "" };
  }

  const segments = data[0];
  if (!Array.isArray(segments)) {
    return { translatedText: "" };
  }

  let translatedText = "";
  for (const segment of segments) {
    if (Array.isArray(segment) && segment.length > 0) {
      const firstElement = segment[0];
      if (typeof firstElement === "string") {
        translatedText += firstElement;
      }
    }
  }

  const detectedLanguageRaw = data[2];
  const detectedLanguage = typeof detectedLanguageRaw === "string" ? detectedLanguageRaw : undefined;

  return { translatedText, ...(detectedLanguage ? { detectedLanguage } : {}) };
}

// MyMemory returns { responseData: { translatedText: string, ... }, ... }.
function extractMyMemoryTranslation(data: unknown): string {
  if (!isRecord(data)) {
    throw new TranslationServiceError("translation_invalid_response", "The MyMemory translation response is malformed.");
  }

  const responseData = data.responseData;
  if (!isRecord(responseData)) {
    throw new TranslationServiceError("translation_invalid_response", "The MyMemory translation response has no responseData.");
  }

  const translatedText = responseData.translatedText;
  if (typeof translatedText !== "string") {
    throw new TranslationServiceError("translation_invalid_response", "The MyMemory translation response has no translated text.");
  }

  return translatedText;
}

function httpErrorForStatus(status: number): TranslationServiceError {
  if (status === 429) {
    return new TranslationServiceError("translation_rate_limited", "The translation service is rate limited.");
  }
  if (status >= 500) {
    return new TranslationServiceError("translation_service_unavailable", "The translation service is unavailable.");
  }
  return new TranslationServiceError("translation_service_rejected", "The translation service rejected the request.");
}

/**
 * Built-in free translation service that chains two no-key APIs:
 * Google Translate's unofficial endpoint (primary) and MyMemory (fallback).
 * No configuration is required, so the service is always available.
 */
export class BuiltinTranslationService {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: BuiltinTranslationServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  isAvailable(): boolean {
    return true;
  }

  async translate(text: string, targetLocale: string, signal?: AbortSignal): Promise<TranslationResult> {
    if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
      throw new TranslationServiceError("translation_request_too_large", "The message is too large to translate.");
    }
    if (!text.trim()) {
      throw new TranslationServiceError("translation_content_unavailable", "The message does not contain translatable text.");
    }

    const targetLanguage = translationLanguageForLocale(targetLocale);

    let lastError: TranslationServiceError | undefined;
    const detectedLanguageRef: DetectedLanguageRef = {};

    // Engine 1: Google Translate unofficial API (primary).
    try {
      return await this.translateWithGoogle(text, targetLanguage, signal, detectedLanguageRef);
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        lastError = error;
      } else {
        lastError = new TranslationServiceError("translation_service_unavailable", "The Google translation service is unavailable.");
      }
    }

    // Engine 2: MyMemory API (fallback). Use the Google-detected source language
    // when available because MyMemory does not support automatic source detection.
    const sourceLanguage = detectedLanguageRef.value ?? MYMEMORY_DEFAULT_SOURCE_LANGUAGE;
    try {
      return await this.translateWithMyMemory(text, targetLanguage, sourceLanguage, signal);
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        lastError = error;
      } else {
        lastError = new TranslationServiceError("translation_service_unavailable", "The MyMemory translation service is unavailable.");
      }
    }

    throw lastError ?? new TranslationServiceError("translation_service_unavailable", "All translation engines failed.");
  }

  /** Translates using only the Google engine (used as a standalone provider). */
  async translateWithGoogleOnly(text: string, targetLocale: string, signal?: AbortSignal): Promise<TranslationResult> {
    if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
      throw new TranslationServiceError("translation_request_too_large", "The message is too large to translate.");
    }
    if (!text.trim()) {
      throw new TranslationServiceError("translation_content_unavailable", "The message does not contain translatable text.");
    }
    const targetLanguage = translationLanguageForLocale(targetLocale);
    return this.translateWithGoogle(text, targetLanguage, signal, {});
  }

  /** Translates using only the MyMemory engine (used as a standalone provider). */
  async translateWithMyMemoryOnly(text: string, targetLocale: string, signal?: AbortSignal): Promise<TranslationResult> {
    if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
      throw new TranslationServiceError("translation_request_too_large", "The message is too large to translate.");
    }
    if (!text.trim()) {
      throw new TranslationServiceError("translation_content_unavailable", "The message does not contain translatable text.");
    }
    const targetLanguage = translationLanguageForLocale(targetLocale);
    return this.translateWithMyMemory(text, targetLanguage, MYMEMORY_DEFAULT_SOURCE_LANGUAGE, signal);
  }

  private async translateWithGoogle(
    text: string,
    targetLanguage: string,
    externalSignal: AbortSignal | undefined,
    detectedLanguageRef: DetectedLanguageRef,
  ): Promise<TranslationResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BUILTIN_TRANSLATION_TIMEOUT_MS);

    const abortForExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortForExternalSignal, { once: true });

    try {
      const body = new URLSearchParams({
        client: "gtx",
        sl: "auto",
        tl: targetLanguage,
        dt: "t",
        q: text,
      });

      const response = await this.fetchImpl(GOOGLE_TRANSLATE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw httpErrorForStatus(response.status);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new TranslationServiceError("translation_invalid_response", "The Google translation response is not valid JSON.");
      }

      const extracted = extractGoogleTranslation(data);

      // Capture the detected language before validating the translation so the
      // MyMemory fallback can reuse it even when the translation is unusable.
      if (extracted.detectedLanguage) {
        detectedLanguageRef.value = extracted.detectedLanguage;
      }

      const translatedText = extracted.translatedText.trim();
      if (!translatedText) {
        throw new TranslationServiceError("translation_invalid_response", "The Google translation service returned no text.");
      }

      return {
        translatedText,
        ...(extracted.detectedLanguage ? { detectedLanguage: extracted.detectedLanguage } : {}),
      };
    } catch (error) {
      if (error instanceof TranslationServiceError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TranslationServiceError(
          timedOut ? "translation_timeout" : "translation_service_unavailable",
          timedOut
            ? "The Google translation request timed out."
            : "The Google translation request was interrupted.",
        );
      }
      throw new TranslationServiceError("translation_service_unavailable", "The Google translation service is unavailable.");
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortForExternalSignal);
    }
  }

  private async translateWithMyMemory(
    text: string,
    targetLanguage: string,
    sourceLanguage: string,
    externalSignal: AbortSignal | undefined,
  ): Promise<TranslationResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BUILTIN_TRANSLATION_TIMEOUT_MS);

    const abortForExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortForExternalSignal, { once: true });

    try {
      const url = new URL(MYMEMORY_ENDPOINT);
      url.searchParams.set("q", text);
      url.searchParams.set("langpair", `${sourceLanguage}|${targetLanguage}`);

      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw httpErrorForStatus(response.status);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new TranslationServiceError("translation_invalid_response", "The MyMemory translation response is not valid JSON.");
      }

      const translatedText = extractMyMemoryTranslation(data).trim();
      if (!translatedText) {
        throw new TranslationServiceError("translation_invalid_response", "The MyMemory translation service returned no text.");
      }

      return { translatedText };
    } catch (error) {
      if (error instanceof TranslationServiceError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TranslationServiceError(
          timedOut ? "translation_timeout" : "translation_service_unavailable",
          timedOut
            ? "The MyMemory translation request timed out."
            : "The MyMemory translation request was interrupted.",
        );
      }
      throw new TranslationServiceError("translation_service_unavailable", "The MyMemory translation service is unavailable.");
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortForExternalSignal);
    }
  }
}

export type BuiltinEngineId = "google" | "mymemory";

/**
 * A translation provider that always succeeds structurally (isConfigured() ->
 * true) and routes through a primary/backup chain of engines:
 *   1. the primary engine (or a custom LibreTranslate endpoint)
 *   2. the backup engine (or the remaining built-in)
 *   3. the built-in chain (Google -> MyMemory)
 * Used when the user picks a built-in provider as primary/backup.
 */
export class BuiltinTranslationChain {
  private readonly builtin = new BuiltinTranslationService();
  private readonly custom: TranslationService | undefined;

  constructor(
    private readonly primary: BuiltinEngineId | "custom",
    private readonly backup: BuiltinEngineId | "custom",
    customOptions?: TranslationServiceOptions,
  ) {
    if (customOptions?.endpoint?.trim()) {
      this.custom = new TranslationService(customOptions);
    }
  }

  isConfigured(): boolean {
    return true;
  }

  configurationIssue(): TranslationServiceError | undefined {
    return undefined;
  }

  async translate(text: string, targetLocale: string, signal?: AbortSignal): Promise<TranslationResult> {
    const engines: Array<{ id: BuiltinEngineId | "custom"; label: string }> = [];
    if (this.custom && this.primary === "custom") engines.push({ id: "custom", label: "custom" });
    if (this.primary !== "custom") engines.push({ id: this.primary, label: this.primary });
    if (this.custom && this.backup === "custom") engines.push({ id: "custom", label: "custom" });
    if (this.backup !== "custom") engines.push({ id: this.backup, label: this.backup });
    // Final safety net: the full built-in chain (Google -> MyMemory).
    engines.push({ id: "google", label: "builtin-chain" });

    let lastError: TranslationServiceError | undefined;
    for (const engine of engines) {
      try {
        if (engine.id === "custom") {
          if (!this.custom) throw new TranslationServiceError("translation_not_configured", "The custom translation service is not configured.");
          return await this.custom.translate(text, targetLocale, signal);
        }
        if (engine.id === "google") {
          // If this is the explicit google engine (primary or backup), use it
          // alone; the trailing builtin-chain slot (also google) is the full
          // Google -> MyMemory chain.
          if (engine.label !== "builtin-chain") {
            return await this.builtin.translateWithGoogleOnly(text, targetLocale, signal);
          }
          return await this.builtin.translate(text, targetLocale, signal);
        }
        if (engine.id === "mymemory") {
          return await this.builtin.translateWithMyMemoryOnly(text, targetLocale, signal);
        }
      } catch (error) {
        lastError = error instanceof TranslationServiceError
          ? error
          : new TranslationServiceError("translation_service_unavailable", "The translation service is unavailable.");
      }
    }
    throw lastError ?? new TranslationServiceError("translation_service_unavailable", "All translation engines failed.");
  }
}
