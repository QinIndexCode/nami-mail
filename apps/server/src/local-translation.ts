import {
  MAX_TRANSLATION_TEXT_LENGTH,
  TranslationServiceError,
  type TranslationResult,
  translationLanguageForLocale,
} from "./translation.js";

/**
 * NLLB-200 FLORES-200 language mapping. The transformers.js NLLB pipeline
 * uses Meta's BCP-47-style codes (for example zho_Hans and eng_Latn). Keep
 * only the supported locale mappings and fall back to English when absent.
 */
const LOCALE_TO_NLLB: Readonly<Record<string, string>> = {
  zh: "zho_Hans",
  en: "eng_Latn",
  ja: "jpn_Jpan",
  ko: "kor_Hang",
  fr: "fra_Latn",
  de: "deu_Latn",
  es: "spa_Latn",
  ru: "rus_Cyrl",
  ar: "arb_Arab",
  pt: "por_Latn",
  it: "ita_Latn",
  nl: "nld_Latn",
  pl: "pol_Latn",
  tr: "tur_Latn",
  vi: "vie_Latn",
  th: "tha_Thai",
  id: "ind_Latn",
  hi: "hin_Deva",
};

const NLLB_FALLBACK_LANGUAGE = "eng_Latn";
const NLLB_MODEL_ID = "Xenova/nllb-200-distilled-600M";

type NllbTranslationOutput = {
  translation_text?: unknown;
};

type NllbPipeline = {
  (text: string, options: {
    tgt_lang: string;
    callback?: (progress: unknown) => void;
  }): Promise<NllbTranslationOutput[]>;
};

type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
    options?: { cache_dir?: string; device?: string; dtype?: string },
  ) => Promise<NllbPipeline>;
  env: {
    cacheDir: string;
    allowLocalModels: boolean;
    useBrowserCache: boolean;
  };
};

let transformersModulePromise: Promise<TransformersModule> | undefined;

async function loadTransformers(): Promise<TransformersModule> {
  if (!transformersModulePromise) {
    // Avoid loading the ONNX runtime in pure Node test environments.
    transformersModulePromise = import("@huggingface/transformers") as Promise<TransformersModule>;
  }
  return transformersModulePromise;
}

function nllbLanguageForLocale(locale: string): string {
  const language = translationLanguageForLocale(locale);
  return LOCALE_TO_NLLB[language] ?? NLLB_FALLBACK_LANGUAGE;
}

/**
 * Offline translation backed by Meta's distilled NLLB-200 model. It downloads
 * and caches the model under user data without requiring an external endpoint.
 *
 * The class conforms to the same public interface as {@link TranslationService}
 * so Electron can inject it through `RuntimeContext.translationService`.
 */
export class LocalTranslationService {
  private readonly cacheDir: string;
  private pipelinePromise: Promise<NllbPipeline> | undefined;
  private readonly configurationError: TranslationServiceError | undefined;

  constructor(options: { cacheDir: string }) {
    if (!options.cacheDir?.trim()) {
      this.configurationError = new TranslationServiceError(
        "translation_not_configured",
        "The local translation cache directory is required.",
      );
      this.cacheDir = "";
      return;
    }
    this.cacheDir = options.cacheDir;
  }

  isConfigured(): boolean {
    return !this.configurationError;
  }

  configurationIssue(): TranslationServiceError | undefined {
    return this.configurationError;
  }

  private async loadPipeline(): Promise<NllbPipeline> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      const transformers = await loadTransformers();
      transformers.env.cacheDir = this.cacheDir;
      // Desktop always uses the configured on-disk cache directory.
      transformers.env.useBrowserCache = false;
      transformers.env.allowLocalModels = false;
      const pipeline = await transformers.pipeline("translation", NLLB_MODEL_ID, {
        cache_dir: this.cacheDir,
        dtype: "q8",
      }) as NllbPipeline;
      return pipeline;
    })();
    return this.pipelinePromise;
  }

  async translate(text: string, targetLocale: string, shutdownSignal?: AbortSignal): Promise<TranslationResult> {
    if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
      throw new TranslationServiceError("translation_request_too_large", "The message is too large to translate.");
    }
    if (!text.trim()) {
      throw new TranslationServiceError("translation_content_unavailable", "The message does not contain translatable text.");
    }
    if (this.configurationError) {
      throw this.configurationError;
    }

    const targetLanguage = nllbLanguageForLocale(targetLocale);

    if (shutdownSignal?.aborted) {
      throw new TranslationServiceError("translation_service_unavailable", "The translation request was interrupted during shutdown.");
    }

    try {
      const pipeline = await this.loadPipeline();
      if (shutdownSignal?.aborted) {
        throw new TranslationServiceError("translation_service_unavailable", "The translation request was interrupted during shutdown.");
      }
      const output = await pipeline(text, { tgt_lang: targetLanguage });
      const translatedText = typeof output[0]?.translation_text === "string"
        ? output[0].translation_text.trim()
        : "";
      if (!translatedText) {
        throw new TranslationServiceError("translation_invalid_response", "The translation service returned no text.");
      }
      if (translatedText.length > MAX_TRANSLATION_TEXT_LENGTH) {
        throw new TranslationServiceError("translation_response_too_large", "The translation service response is too large.");
      }
      // Offline NLLB does not detect a source language. Return the target so
      // TranslationPanel can describe the produced translation accurately.
      return { translatedText, detectedLanguage: targetLocale.split("-", 1)[0] };
    } catch (error) {
      if (error instanceof TranslationServiceError) throw error;
      throw new TranslationServiceError("translation_service_unavailable", "The local translation service is unavailable.");
    }
  }
}
