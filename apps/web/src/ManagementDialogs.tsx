import { useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import ContactsSection from "./ContactsSection";
import TemplatesSection from "./TemplatesSection";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";

/**
 * Shared dialog shell for management surfaces that were split out of the
 * settings modal (contacts, templates, accounts). The embedded section renders
 * without its own heading; the dialog header carries the title and description.
 */
export function ManagementDialogShell({
  titleId,
  title,
  description,
  eyebrow,
  onClose,
  closing: closingProp,
  requestClose: requestCloseProp,
  fallbackFocusRef,
  dialogRef,
  focusSuspended,
  children,
}: {
  titleId: string;
  title: string;
  description: string;
  eyebrow: string;
  onClose: () => void;
  /**
   * Optional externally-managed exit transition (closing state + close
   * request) from a host that already owns one. Without these the shell
   * creates its own; the two must never both run, or the exit animation
   * restarts when the shell clears its closing state mid-close.
   */
  closing?: boolean;
  requestClose?: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Optional ref to the dialog card, used by hosts that layer nested overlays. */
  dialogRef?: RefObject<HTMLElement | null>;
  /**
   * Pass true while a nested overlay (editor, confirmation) is open so the
   * shell's focus trap stands down and lets the overlay's own trap own the
   * focus; without this the two traps fight and typing into the overlay is
   * impossible because focus keeps getting pulled back into the shell.
   */
  focusSuspended?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const innerRef = useRef<HTMLElement>(null);
  const sectionRef = dialogRef ?? innerRef;
  useDialogFocus(true, sectionRef, { fallbackFocusRef, suspended: focusSuspended });
  const { closing: selfClosing, requestClose: selfRequestClose } = useDismissTransition(onClose);
  const closing = closingProp ?? selfClosing;
  const requestClose = requestCloseProp ?? selfRequestClose;
  return (
    <div className={`modal-backdrop management-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section ref={sectionRef} className={`modal-card management-dialog${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-heading management-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
            <p className="management-heading-description">{description}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.close")} data-tooltip={t("common.close")} onClick={requestClose}>
            <X size={18} />
          </button>
        </header>
        <div className="management-dialog-body">{children}</div>
      </section>
    </div>
  );
}

export type ContactsDialogProps = {
  demoMode?: boolean;
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

export function ContactsDialog({ demoMode = false, onClose, fallbackFocusRef }: ContactsDialogProps) {
  const { t } = useI18n();
  return (
    <ManagementDialogShell
      titleId="contacts-dialog-title"
      eyebrow={t("navigation.management")}
      title={t("settings.contacts.title")}
      description={t("settings.contacts.description")}
      onClose={onClose}
      fallbackFocusRef={fallbackFocusRef}
    >
      <ContactsSection demoMode={demoMode} />
    </ManagementDialogShell>
  );
}

export type TemplatesDialogProps = {
  demoMode?: boolean;
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

export function TemplatesDialog({ demoMode = false, onClose, fallbackFocusRef }: TemplatesDialogProps) {
  const { t } = useI18n();
  return (
    <ManagementDialogShell
      titleId="templates-dialog-title"
      eyebrow={t("navigation.management")}
      title={t("settings.templates.title")}
      description={t("settings.templates.description")}
      onClose={onClose}
      fallbackFocusRef={fallbackFocusRef}
    >
      <TemplatesSection demoMode={demoMode} />
    </ManagementDialogShell>
  );
}
