import {
  MAX_TRANSLATION_TEXT_LENGTH,
  TranslationServiceError,
  type TranslationResult,
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
