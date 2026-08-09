import { useRef, type ReactNode } from "react";
import { Eye, EyeOff, Languages, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useI18n } from "./i18n";
import type { MailVisualStyle } from "./translationPresentation";

const URL_RE = /(https?:\/\/[^\s<>"']+)/gi;

/**
 * Renders plain translated text with light formatting: paragraphs separated by
 * blank lines, single line breaks preserved, and URLs auto-linked.  No HTML
 * from the translation service is ever injected — only React elements created
 * here, so there is no XSS surface.
 */
function formatTranslationText(text: string): ReactNode[] {
  if (!text || !text.trim()) return [text];
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((paragraph, pIndex) => {
    const lines = paragraph.split("\n");
    const formattedLines = lines.map((line, lineIndex) => {
      const segments = line.split(URL_RE);
      return (
        <span key={lineIndex}>
          {segments.map((seg, segIndex) => {
            if (segIndex % 2 === 1) {
              return (
                <a key={segIndex} href={seg} target="_blank" rel="noopener noreferrer">
                  {seg}
                </a>
              );
            }
            return seg;
          })}
          {lineIndex < lines.length - 1 && <br />}
        </span>
      );
    });
    return <p key={pIndex}>{formattedLines}</p>;
  });
}

export type TranslationContent = {
  translatedText: string;
  detectedLanguage?: string;
  visible: boolean;
  /** True while a chunked translation stream is still in progress. */
  streaming?: boolean;
};

export type TranslationPanelState =
  | { phase: "idle" }
  | { phase: "loading"; previous?: TranslationContent }
  | { phase: "error"; message: string; previous?: TranslationContent; llmAvailable?: boolean }
  | ({ phase: "ready" } & TranslationContent);

export type TranslationAvailability =
  | "checking"
  | "available"
  | "unavailable"
  | "unknown"
  | "invalid";

type TranslationPanelProps = {
  availability: TranslationAvailability;
  state: TranslationPanelState;
  /** Whether at least one LLM provider is configured and AI translation is possible. */
  llmAvailable?: boolean;
  /** Visual characteristics of the original message so the translated result
   *  keeps the mail provider's branded backdrop instead of a plain panel. */
  mailStyle?: MailVisualStyle;
  onCheckAvailability: () => void;
  onTranslate: () => void;
  onTranslateWithLlm: () => void;
  onShow: () => void;
  onHide: () => void;
  onCancel?: () => void;
};

function languageDisplayName(language: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}

function contentForState(state: TranslationPanelState): TranslationContent | undefined {
  if (state.phase === "ready") return state;
  return state.phase === "loading" || state.phase === "error" ? state.previous : undefined;
}

export default function TranslationPanel({ availability, state, llmAvailable, mailStyle, onCheckAvailability, onTranslate, onTranslateWithLlm, onShow, onHide, onCancel }: TranslationPanelProps) {
  const { locale, locales, t } = useI18n();
  const actionRef = useRef<HTMLButtonElement>(null);
  const targetName = locales.find((item) => item.locale === locale)?.nativeName ?? locale;
  const content = contentForState(state);
  const isLoading = state.phase === "loading";
  const isVisible = Boolean(content?.visible);

  const restoreActionFocus = () => {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => actionRef.current?.focus());
  };
  const hideTranslation = () => {
    onHide();
    restoreActionFocus();
  };

  // When an LLM translation is in progress or has produced a result, skip the
  // availability gate so the loading state and translated text render normally
  // even if the free translation service was never configured.
  const hasActiveTranslation = state.phase === "loading" || state.phase === "ready";

  if (availability !== "available" && !hasActiveTranslation) {
    const message = availability === "checking"
      ? t("translation.availability.checking")
      : availability === "unavailable"
        ? t("translation.availability.unavailable")
        : availability === "invalid"
          ? t("translation.availability.invalid")
          : t("translation.availability.unknown");
    const title = t("translation.unavailableTitle");
    const actionLabel = t("translation.checkConfiguration");
    const showLlmEntry = Boolean(llmAvailable) && availability !== "checking";
    return (
      <section className="translation-panel is-unavailable" aria-label={t("translation.regionAria")} aria-busy={availability === "checking"} role="status" aria-live="polite">
        <div className="translation-surface translation-unavailable">
          <div className="translation-heading">
            <div>
              <span><Languages size={16} aria-hidden="true" />{title}</span>
              <p>{message}</p>
            </div>
            {availability !== "checking" && (
              <button className="secondary-button translation-action" type="button" onClick={onCheckAvailability}>
                <RefreshCw size={15} aria-hidden="true" />{actionLabel}
              </button>
            )}
          </div>
          {state.phase === "error" && <div className="translation-error" role="alert">{state.message}</div>}
          {showLlmEntry && (
            <div className="translation-llm-fallback">
              <button className="secondary-button translation-llm-action" type="button" onClick={onTranslateWithLlm}>
                <Languages size={15} aria-hidden="true" />{t("translation.llmFallback")}
              </button>
              <small>{t("translation.llmCostNote")}</small>
            </div>
          )}
        </div>
      </section>
    );
  }

  const actionLabel = isLoading
    ? t("translation.translating")
    : state.phase === "error"
      ? t("common.retry")
      : content && !isVisible
        ? t("translation.show")
        : content
          ? t("translation.retranslate", { language: targetName })
          : t("translation.action", { language: targetName });
  const actionIcon = isLoading
    ? <LoaderCircle className="spin" size={15} aria-hidden="true" />
    : state.phase === "error" || Boolean(content && isVisible)
      ? <RefreshCw size={15} aria-hidden="true" />
      : content
        ? <Eye size={15} aria-hidden="true" />
        : <Languages size={15} aria-hidden="true" />;
  const statusMessage = isLoading
    ? t("translation.status.translating")
    : state.phase === "ready"
      ? isVisible
        ? t("translation.status.ready", { language: targetName })
        : t("translation.status.hidden")
      : "";

  return (
    <section className={`translation-panel is-${state.phase}`} aria-label={t("translation.regionAria")} aria-busy={isLoading}>
      <div className="translation-surface">
        <div className="translation-heading">
          <div>
            <span><Languages size={16} aria-hidden="true" />{t("translation.title", { language: targetName })}</span>
            <p>{t("translation.disclaimer")}</p>
          </div>
          <button
            ref={actionRef}
            className="secondary-button translation-action"
            type="button"
            onClick={state.phase !== "error" && content && !isVisible ? onShow : (availability === "available" ? onTranslate : onTranslateWithLlm)}
            disabled={isLoading || Boolean(content?.streaming)}
          >
            {actionIcon}{actionLabel}
          </button>
          {isLoading && onCancel && !content?.streaming && (
            <button type="button" className="secondary-button translation-cancel-action" onClick={onCancel} aria-label={t("translation.cancel")} data-tooltip={t("translation.cancel")}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="visually-hidden" role="status" aria-live="polite">{statusMessage}</span>
        {state.phase === "error" && <div className="translation-error" role="alert">{state.message}</div>}
        {state.phase === "error" && state.llmAvailable && (
          <div className="translation-llm-fallback">
            <button className="secondary-button translation-llm-action" type="button" onClick={onTranslateWithLlm}>
              <Languages size={15} aria-hidden="true" />{t("translation.llmFallback")}
            </button>
            <small>{t("translation.llmCostNote")}</small>
          </div>
        )}
        {isVisible && content && (
          <div className="translation-result" role="region" aria-label={t("translation.resultAria", { language: targetName })}>
            <div className="translation-result-heading">
              <span>{t("translation.resultTitle", { language: targetName })}</span>
              <div>
                {content.streaming && <span className="translation-streaming-indicator"><LoaderCircle className="spin" size={12} aria-hidden="true" /> {t("translation.translating")}</span>}
                {content.streaming && onCancel && <button type="button" className="translation-cancel-action" onClick={onCancel} aria-label={t("translation.cancel")} data-tooltip={t("translation.cancel")}><X size={14} aria-hidden="true" /></button>}
                {content.detectedLanguage && <small>{t("translation.detectedLanguage", { language: languageDisplayName(content.detectedLanguage, locale) })}</small>}
                <button type="button" onClick={hideTranslation} aria-label={t("translation.hide")} data-tooltip={t("translation.hide")}>
                  <EyeOff size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className={`translation-text${mailStyle ? " has-mail-surface" : ""}`} style={mailStyle ? {
              backgroundColor: mailStyle.background,
              ...(mailStyle.color ? { color: mailStyle.color } : {}),
              ...(mailStyle.fontFamily ? { fontFamily: mailStyle.fontFamily } : {}),
              ...(mailStyle.fontSize ? { fontSize: mailStyle.fontSize } : {}),
            } : undefined}>{formatTranslationText(content.translatedText)}</div>
          </div>
        )}
      </div>
    </section>
  );
}
