import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useDismissTransition } from "../hooks/useDismissTransition";
import type { Translate } from "../i18n";
import type { ModelFeedback } from "./settings-models";
import { expandedThemedSelectOwnsEscape } from "./settings-utils";

/**
 * The shell both "models" forms live in: a small modal stacked over the
 * settings panel. It reuses the contact editor's dialog (backdrop + card + head
 * + action row) and the calendar event form's `.calendar-field` rows rather
 * than inventing a third dialog look.
 *
 * Two rules the panel depends on:
 * - feedback for a save or a check renders inside the dialog, next to the form
 *   that produced it;
 * - a dialog holding unsaved input asks before dropping it, and a dialog that is
 *   mid-save never closes at all (the save also checks the connection, which can
 *   take tens of seconds — losing the dialog then means the user never sees the
 *   result).
 */

/** A form row: label above the control, optional hint under the label. */
export function ModelField({ id, label, hint, children }: {
  id?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const content = (
    <>
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
      {children}
    </>
  );
  // A plain field takes an <input type=text> from the label; a control group
  // (the environment editor holds its own inputs) must not nest labels.
  return id
    ? <label className="calendar-field" htmlFor={id}>{content}</label>
    : <div className="calendar-field">{content}</div>;
}

/** One outcome line plus, for failures, the action that repeats it. */
export function ModelFeedbackLine({ feedback, retryLabel, busy = false }: {
  feedback: ModelFeedback;
  retryLabel: string;
  /** A retry already in flight must not be started twice. */
  busy?: boolean;
}) {
  const failed = feedback.kind === "error";
  return (
    <p className={`settings-model-feedback${failed ? " error" : " success"}`} role={failed ? "alert" : "status"}>
      {failed ? <CircleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      <span>{feedback.message}</span>
      {feedback.retry && (
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void feedback.retry?.()}>
          <RefreshCw size={13} />{retryLabel}
        </button>
      )}
    </p>
  );
}

export type SettingsModelFormDialogProps = {
  /** The dialog stays mounted while a save or check is running. */
  busy: boolean;
  /** The form holds unsaved input, so closing asks first. */
  dirty: boolean;
  t: Translate;
  eyebrow: string;
  title: string;
  hint: string;
  /** id of the heading element; also the dialog's accessible name. */
  labelledBy: string;
  /** Which card this form belongs to; lands on <form data-models-form>. */
  formId: "provider" | "mcp";
  feedback: ModelFeedback | null;
  retryLabel: string;
  submitLabel: string;
  /** Label + spinner state shown while `busy`. */
  busyLabel: string;
  cancelLabel: string;
  /** Reported upward so the settings modal disables its own controls. */
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
  fields: ReactNode;
};

export function SettingsModelFormDialog({
  busy,
  dirty,
  t,
  eyebrow,
  title,
  hint,
  labelledBy,
  formId,
  feedback,
  retryLabel,
  submitLabel,
  busyLabel,
  cancelLabel,
  onBusyChange,
  onClose,
  onSubmit,
  fields,
}: SettingsModelFormDialogProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  // Mount instant, for the backdrop guard below.
  const mountedAtRef = useRef(Date.now());
  const { closing, requestClose: requestDialogClose } = useDismissTransition(onClose);
  const {
    closing: confirmClosing,
    requestClose: requestConfirmClose,
    reset: resetConfirmClosing,
  } = useDismissTransition(() => setConfirmDiscard(false));

  useDialogFocus(!confirmDiscard, panelRef);
  useDialogFocus(confirmDiscard, confirmationRef);

  // The settings modal must not close itself (Escape, backdrop, "done") while
  // this overlay is up, and must not fight its focus trap either. It reads one
  // flag reported by the panel, not one per dialog — see SettingsModelsSection.
  //
  // `busy` is cleared on the way out too: the panel is remounted whenever the
  // settings category changes, and a save that never got to report its own end
  // would otherwise leave the whole settings modal permanently disabled.
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const requestClose = () => {
    // Mid-save the form belongs to the pending request; closing it here would
    // hide the save result the user is waiting for.
    if (busy) return;
    if (dirty) {
      resetConfirmClosing();
      setConfirmDiscard(true);
      return;
    }
    requestDialogClose();
  };

  const requestCloseFromBackdrop = () => {
    // A double-click on "add model" opens this dialog and then lands its second
    // mousedown on the backdrop the first click just mounted — that backdrop
    // covers the screen milliseconds later, so the dialog closed itself before
    // a single character could be typed. A deliberate backdrop dismissal is a
    // slower, separate gesture, so the first moments after mount are ignored.
    if (Date.now() - mountedAtRef.current < 250) return;
    requestClose();
  };

  // Escape peels one layer: the discard confirmation first, the dialog after.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
      if (expandedThemedSelectOwnsEscape(target, activeElement)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (confirmDiscard) requestConfirmClose();
      else requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  });

  return (
    <>
      <div
        className={`modal-backdrop contact-editor-backdrop${closing ? " closing" : ""}`}
        role="presentation"
        onMouseDown={(event) => event.target === event.currentTarget && requestCloseFromBackdrop()}
      >
        <section
          ref={panelRef}
          className={`contact-editor-modal${closing ? " closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
        >
          <form
            className="contact-editor"
            data-models-form={formId}
            aria-label={title}
            onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
          >
            <div className="contact-editor-head">
              <div>
                <span className="eyebrow">{eyebrow}</span>
                <h3 id={labelledBy} className="contact-editor-title">{title}</h3>
                <small>{hint}</small>
              </div>
            </div>
            {fields}
            {feedback && <ModelFeedbackLine feedback={feedback} retryLabel={retryLabel} busy={busy} />}
            <div className="contact-editor-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={requestClose}>
                <X size={15} />{cancelLabel}
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                {busy ? busyLabel : submitLabel}
              </button>
            </div>
          </form>
        </section>
      </div>
      {confirmDiscard && (
        <div
          className={`modal-backdrop confirmation-backdrop${confirmClosing ? " closing" : ""}`}
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && requestConfirmClose()}
        >
          <section
            ref={confirmationRef}
            className={`confirmation-card${confirmClosing ? " closing" : ""}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="models-discard-title"
            aria-describedby="models-discard-description"
            tabIndex={-1}
          >
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            <h3 id="models-discard-title">{t("settings.confirmation.discardModelChangesTitle")}</h3>
            <p id="models-discard-description">{t("settings.confirmation.discardModelChangesDescription")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus onClick={requestConfirmClose}>
                {cancelLabel}
              </button>
              <button className="secondary-button danger-button" type="button" onClick={onClose}>
                {t("settings.confirmation.discardModelChangesAction")}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}