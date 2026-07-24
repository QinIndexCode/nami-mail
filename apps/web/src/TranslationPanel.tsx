import { useRef } from "react";
import { Eye, EyeOff, Languages, LoaderCircle, RefreshCw } from "lucide-react";
import { useI18n } from "./i18n";

export type TranslationContent = {
  translatedText: string;
  detectedLanguage?: string;
  visible: boolean;
};

export type TranslationPanelState =
  | { phase: "idle" }
  | { phase: "loading"; previous?: TranslationContent }
  | { phase: "error"; message: string; previous?: TranslationContent }
  | ({ phase: "ready" } & TranslationContent);

export type TranslationAvailability = "checking" | "available" | "unavailable" | "unknown" | "invalid";

type TranslationPanelProps = {
  availability: TranslationAvailability;
  state: TranslationPanelState;
  onCheckAvailability: () => void;
  onTranslate: () => void;
  onShow: () => void;
  onHide: () => void;
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

export default function TranslationPanel({ availability, state, onCheckAvailability, onTranslate, onShow, onHide }: TranslationPanelProps) {
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

  if (availability !== "available") {
    const message = availability === "checking"
      ? t("translation.availability.checking")
      : availability === "unavailable"
      ? t("translation.availability.unavailable")
        : availability === "invalid"
          ? t("translation.availability.invalid")
          : t("translation.availability.unknown");
    return (
      <section className="translation-panel is-unavailable" aria-label={t("translation.regionAria")} aria-busy={availability === "checking"} role="status" aria-live="polite">
        <div className="translation-surface translation-unavailable">
          <div className="translation-heading">
            <div>
              <span><Languages size={16} aria-hidden="true" />{t("translation.unavailableTitle")}</span>
              <p>{message}</p>
            </div>
            {availability !== "checking" && (
              <button className="secondary-button translation-action" type="button" onClick={onCheckAvailability}>
                <RefreshCw size={15} aria-hidden="true" />{t("translation.checkConfiguration")}
              </button>
            )}
          </div>
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
            onClick={state.phase !== "error" && content && !isVisible ? onShow : onTranslate}
            disabled={isLoading}
          >
            {actionIcon}{actionLabel}
          </button>
        </div>
        <span className="visually-hidden" role="status" aria-live="polite">{statusMessage}</span>
        {state.phase === "error" && <div className="translation-error" role="alert">{state.message}</div>}
        {isVisible && content && (
          <div className="translation-result" role="region" aria-label={t("translation.resultAria", { language: targetName })}>
            <div className="translation-result-heading">
              <span>{t("translation.resultTitle", { language: targetName })}</span>
              <div>
                {content.detectedLanguage && <small>{t("translation.detectedLanguage", { language: languageDisplayName(content.detectedLanguage, locale) })}</small>}
                <button type="button" onClick={hideTranslation} aria-label={t("translation.hide")} data-tooltip={t("translation.hide")}>
                  <EyeOff size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="translation-text">{content.translatedText}</div>
          </div>
        )}
      </div>
    </section>
  );
}
