import { useLayoutEffect, useRef } from "react";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useDismissTransition } from "./hooks/useDismissTransition";

export type TranslationTermsDialogProps = {
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

// First-use consent dialog for the application. Covers terms of use, privacy
// policy, and translation feature authorization. Modal consent requires an
// explicit choice, so the backdrop is not dismissible and Escape declines.
export default function TranslationTermsDialog({ open, onAccept, onDecline }: TranslationTermsDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const { closing, requestClose } = useDismissTransition(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  });

  useDialogFocus(open || closing, dialogRef);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingActionRef.current = onDecline;
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [open, onDecline, requestClose]);

  if (!open && !closing) return null;

  const exitWith = (action: () => void) => {
    pendingActionRef.current = action;
    requestClose();
  };

  return (
    <div className={`modal-backdrop translation-terms-backdrop${closing ? " closing" : ""}`} role="presentation">
      <section
        ref={dialogRef}
        className={`translation-terms-card${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="translation-terms-title"
        aria-describedby="translation-terms-description"
        tabIndex={-1}
      >
        <header className="translation-terms-heading">
          <h2 id="translation-terms-title">{t("translation.terms.title")}</h2>
          <p id="translation-terms-description">{t("translation.terms.description")}</p>
        </header>

        <div className="translation-terms-content">
          <section className="translation-terms-section">
            <h3>{t("translation.terms.termsTitle")}</h3>
            <p>{t("translation.terms.termsContent")}</p>
          </section>
          <section className="translation-terms-section">
            <h3>{t("translation.terms.privacyTitle")}</h3>
            <p>{t("translation.terms.privacyContent")}</p>
          </section>
          <section className="translation-terms-section">
            <h3>{t("translation.terms.consent")}</h3>
            <p>{t("translation.terms.consentContent")}</p>
          </section>
        </div>

        <footer className="translation-terms-actions">
          <button className="secondary-button" type="button" onClick={() => exitWith(onDecline)}>
            {t("translation.terms.decline")}
          </button>
          <button className="primary-button" type="button" data-dialog-initial-focus onClick={() => exitWith(onAccept)}>
            {t("translation.terms.accept")}
          </button>
        </footer>
      </section>
    </div>
  );
}
