import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, LoaderCircle, Mail, PenLine, RefreshCw, Send, X } from "lucide-react";
import { mailErrorMessage, mailErrorToastMessage } from "./errorPresentation";
import { translate, type Translate, useI18n } from "./i18n";
import {
  newMessageDraftFromSubmission,
  recipientSummary,
  submissionMessageIdSuffix,
  submissionStatusPresentation,
} from "./sendingStatus";
import type { Account, OutboundSubmission } from "./types";
import { useDialogFocus } from "./useDialogFocus";

type SendingStatusModalProps = {
  accounts: Account[];
  submissions: OutboundSubmission[];
  loading: boolean;
  loadError: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onSyncAccount: (accountId: string) => Promise<void>;
  onCreateNewMessage: (draft: { accountId: string; to?: string; subject?: string }) => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

type StatusIconButtonProps = {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
};

export function submissionNoticeMessage(
  submission: Pick<OutboundSubmission, "deliveryStatus" | "errorCode" | "errorMessage" | "postSubmitWarning">,
  t: Translate = (key, values) => translate("zh-CN", key, values),
): string | null {
  if (submission.errorMessage) {
    return mailErrorMessage(
      { code: submission.errorCode ?? undefined, message: submission.errorMessage },
      submission.deliveryStatus === "unknown_delivery" ? t("sending.notice.unknownDelivery") : t("sending.notice.incomplete"),
      t,
    );
  }
  if (submission.postSubmitWarning) {
    return mailErrorMessage(
      { code: submission.errorCode ?? undefined, message: submission.postSubmitWarning },
      t("sending.notice.postSubmitIncomplete"),
      t,
    );
  }
  return null;
}

/** Theme-owned tooltip keeps icon actions discoverable without native title bubbles. */
function StatusIconButton({ label, disabled = false, onClick, children }: StatusIconButtonProps) {
  const tooltipId = useId();
  return (
    <span className="app-tooltip app-tooltip-icon">
      <button className="icon-button" type="button" aria-label={label} aria-describedby={tooltipId} onClick={onClick} disabled={disabled}>
        {children}
      </button>
      <span id={tooltipId} className="app-tooltip-content" role="tooltip">{label}</span>
    </span>
  );
}

type TooltipPosition = {
  left: number;
  maxHeight: number;
  placement: "above" | "below";
  top: number;
};

/**
 * Sending records live in a scroll container, so their hover hints are portaled
 * to the document body instead of being cut off by that container.
 */
function StatusValueTooltip({ text, children }: { text: string; children: ReactNode }) {
  const tooltipId = useId();
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useEffect(() => {
    if (!position || typeof window === "undefined") return;
    const dismiss = () => setPosition(null);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [position]);

  const show = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (
      typeof window === "undefined"
      || typeof window.matchMedia !== "function"
      || !window.matchMedia("(hover: hover) and (pointer: fine)").matches
    ) return;

    const anchor = event.currentTarget.getBoundingClientRect();
    const gutter = 16;
    const gap = 8;
    const availableAbove = Math.max(0, anchor.top - gutter - gap);
    const availableBelow = Math.max(0, window.innerHeight - anchor.bottom - gutter - gap);
    const placement = availableBelow >= 120 || availableBelow >= availableAbove ? "below" : "above";
    const availableSpace = placement === "below" ? availableBelow : availableAbove;
    const maxWidth = Math.min(420, Math.max(160, window.innerWidth - gutter * 2));
    const maxLeft = Math.max(gutter, window.innerWidth - maxWidth - gutter);

    setPosition({
      left: Math.max(gutter, Math.min(anchor.left, maxLeft)),
      maxHeight: Math.max(56, Math.min(240, availableSpace)),
      placement,
      top: placement === "below" ? anchor.bottom + gap : anchor.top - gap,
    });
  };

  const tooltipStyle: CSSProperties | undefined = position
    ? { left: position.left, maxHeight: position.maxHeight, top: position.top }
    : undefined;

  return (
    <span className="sending-status-tooltip-trigger" onMouseEnter={show} onMouseLeave={() => setPosition(null)}>
      {children}
      {position && typeof document !== "undefined" && createPortal(
        <span id={tooltipId} className="sending-status-floating-tooltip" data-placement={position.placement} role="tooltip" style={tooltipStyle}>{text}</span>,
        document.body,
      )}
    </span>
  );
}

function formatSubmissionTime(
  value: string,
  formatDate: (input: Date | number | string, options?: Intl.DateTimeFormatOptions) => string,
  t: Translate,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return t("sending.timeUnknown");
  return formatDate(date, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SendingStatusModal({
  accounts,
  submissions,
  loading,
  loadError,
  onClose,
  onRefresh,
  onSyncAccount,
  onCreateNewMessage,
  fallbackFocusRef,
}: SendingStatusModalProps) {
  const { formatDate, t } = useI18n();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmReplacement, setConfirmReplacement] = useState<OutboundSubmission | null>(null);
  const [expandedSubmissionId, setExpandedSubmissionId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const counts = useMemo(() => ({
    active: submissions.filter((item) => ["pending", "submitting", "submitted"].includes(item.deliveryStatus)).length,
    attention: submissions.filter((item) => ["unknown_delivery", "failed"].includes(item.deliveryStatus)).length,
    confirmed: submissions.filter((item) => item.deliveryStatus === "confirmed").length,
  }), [submissions]);

  useDialogFocus(true, dialogRef, { fallbackFocusRef, suspended: Boolean(confirmReplacement) });
  useDialogFocus(Boolean(confirmReplacement), confirmationRef, { fallbackFocusRef: dialogRef });

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (confirmReplacement) setConfirmReplacement(null);
      else onClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [confirmReplacement, onClose]);

  const refresh = async () => {
    if (busyAction) return;
    setBusyAction("refresh");
    setActionError(null);
    try {
      await onRefresh();
    } catch (error) {
      setActionError(mailErrorToastMessage(error, t("sending.error.refresh"), t));
    } finally {
      setBusyAction(null);
    }
  };

  const syncSent = async (submission: OutboundSubmission) => {
    if (busyAction) return;
    setBusyAction(submission.id);
    setActionError(null);
    try {
      await onSyncAccount(submission.accountId);
      await onRefresh();
    } catch (error) {
      setActionError(mailErrorToastMessage(error, t("sending.error.sync"), t));
    } finally {
      setBusyAction(null);
    }
  };

  const createReplacement = () => {
    if (!confirmReplacement) return;
    const draft = newMessageDraftFromSubmission(confirmReplacement);
    setConfirmReplacement(null);
    onCreateNewMessage(draft);
  };

  return (
    <>
      <div className="modal-backdrop sending-status-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !confirmReplacement) onClose();
      }}>
        <section ref={dialogRef} className="modal-card sending-status-modal" role="dialog" aria-modal="true" aria-labelledby="sending-status-title" tabIndex={-1}>
          <header className="modal-heading sending-status-heading">
            <div><span className="eyebrow">{t("sending.modal.eyebrow")}</span><h2 id="sending-status-title">{t("sending.modal.title")}</h2></div>
            <div className="sending-status-heading-actions">
              <StatusIconButton label={t("sending.modal.refreshTooltip")} onClick={() => void refresh()} disabled={loading || Boolean(busyAction)}>
                {loading || busyAction === "refresh" ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              </StatusIconButton>
              <StatusIconButton label={t("sending.modal.closeTooltip")} onClick={onClose}><X size={18} /></StatusIconButton>
            </div>
          </header>

          <div className="sending-status-overview" aria-label={t("sending.modal.overviewLabel")}>
            <span><strong>{counts.active}</strong><small>{t("sending.modal.active")}</small></span>
            <span className={counts.attention ? "attention" : ""}><strong>{counts.attention}</strong><small>{t("sending.modal.attention")}</small></span>
            <span><strong>{counts.confirmed}</strong><small>{t("sending.modal.confirmed")}</small></span>
          </div>

          {(actionError || loadError) && <div className="form-status error sending-status-error" role="alert"><CircleAlert size={16} />{actionError || loadError}</div>}

          <div className="sending-status-list" role="list" aria-label={t("sending.modal.listLabel")} aria-live="polite" aria-busy={loading}>
            {loading && submissions.length === 0 && <div className="sending-status-empty"><LoaderCircle className="spin" size={24} /><p>{t("sending.modal.loading")}</p></div>}
            {!loading && submissions.length === 0 && <div className="sending-status-empty"><Mail size={26} /><h3>{t("sending.modal.emptyTitle")}</h3><p>{t("sending.modal.emptyDescription")}</p></div>}
            {submissions.map((submission) => {
              const presentation = submissionStatusPresentation(submission.deliveryStatus, t);
              const account = accountById.get(submission.accountId);
              const recipients = recipientSummary(submission.recipients, 3, t);
              const fullRecipients = recipientSummary(submission.recipients, Number.MAX_SAFE_INTEGER, t) ?? t("sending.modal.recipientsMissing");
              const title = submission.subject === undefined || submission.subject === null
                ? t("sending.modal.recordTitle", { id: submissionMessageIdSuffix(submission.messageId) })
                : submission.subject || t("sending.modal.untitled");
              const canSync = submission.deliveryStatus === "unknown_delivery" || submission.deliveryStatus === "submitted";
              const canCreate = submission.deliveryStatus === "unknown_delivery" || submission.deliveryStatus === "failed";
              const statusMessage = submissionNoticeMessage(submission, t);
              const detailsId = `sending-status-details-${submission.id}`;
              const detailsExpanded = expandedSubmissionId === submission.id;
              return (
                <article className={`sending-status-item tone-${presentation.tone}`} key={submission.id} role="listitem">
                  <div className="sending-status-item-main">
                    <span className={`sending-status-badge tone-${presentation.tone}`}>
                      {submission.deliveryStatus === "submitting" ? <LoaderCircle className="spin" size={13} /> : submission.deliveryStatus === "confirmed" ? <Check size={13} /> : submission.deliveryStatus === "failed" ? <X size={13} /> : submission.deliveryStatus === "unknown_delivery" ? <CircleAlert size={13} /> : <Send size={13} />}
                      {presentation.label}
                    </span>
                    <time dateTime={submission.updatedAt}>{formatSubmissionTime(submission.updatedAt, formatDate, t)}</time>
                  </div>
                  <h3 className="sending-status-title">
                    <StatusValueTooltip text={title}>
                      <span className="sending-status-truncate">{title}</span>
                    </StatusValueTooltip>
                    <span className="sending-status-mobile-value">{title}</span>
                  </h3>
                  {recipients && (
                    <p className="sending-status-recipients">
                      <StatusValueTooltip text={t("sending.modal.recipientsValue", { recipients: fullRecipients })}>
                        <span className="sending-status-truncate">{t("sending.modal.recipientsValue", { recipients })}</span>
                      </StatusValueTooltip>
                      <span className="sending-status-mobile-value">{t("sending.modal.recipientsValue", { recipients: fullRecipients })}</span>
                    </p>
                  )}
                  <p className="sending-status-detail">{presentation.detail}</p>
                  {statusMessage && (
                    <p className="sending-status-message">{statusMessage}</p>
                  )}
                  <div className="sending-status-meta">
                    <span>{account?.email ?? t("sending.modal.removedAccount")}</span>
                    <StatusValueTooltip text={t("sending.modal.verifyTooltip")}>
                      <code className="sending-status-message-id">{t("sending.modal.verifyId", { id: submissionMessageIdSuffix(submission.messageId) })}</code>
                    </StatusValueTooltip>
                  </div>
                  <button
                    className="sending-status-details-toggle"
                    type="button"
                    aria-controls={detailsId}
                    aria-expanded={detailsExpanded}
                    onClick={() => setExpandedSubmissionId((current) => current === submission.id ? null : submission.id)}
                  >
                    {detailsExpanded ? t("sending.modal.collapseDetails") : t("sending.modal.expandDetails")}
                  </button>
                  <section id={detailsId} className="sending-status-expanded-details" role="region" aria-label={t("sending.modal.detailsRegion", { title })} hidden={!detailsExpanded}>
                    <dl>
                      <div><dt>{t("sending.modal.subject")}</dt><dd>{title}</dd></div>
                      <div><dt>{t("sending.modal.recipientsLabel")}</dt><dd>{fullRecipients}</dd></div>
                      <div><dt>{t("sending.modal.account")}</dt><dd>{account?.email ?? t("sending.modal.removedAccount")}</dd></div>
                      <div><dt>{t("sending.modal.messageId")}</dt><dd><code>{submission.messageId}</code></dd></div>
                    </dl>
                  </section>
                  {(canSync || canCreate) && (
                    <div className="sending-status-actions">
                      {canSync && <button className="secondary-button" type="button" onClick={() => void syncSent(submission)} disabled={Boolean(busyAction)}>{busyAction === submission.id ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t("sending.modal.syncSent")}</button>}
                      {canCreate && <button className="secondary-button" type="button" onClick={() => submission.deliveryStatus === "unknown_delivery" ? setConfirmReplacement(submission) : onCreateNewMessage(newMessageDraftFromSubmission(submission))} disabled={Boolean(busyAction)}><PenLine size={14} />{t("sending.modal.createRetryDraft")}</button>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>

      {confirmReplacement && (
        <div className="modal-backdrop confirmation-backdrop sending-status-confirmation-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConfirmReplacement(null);
        }}>
          <section ref={confirmationRef} className="confirmation-card sending-status-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="confirm-new-message-title" aria-describedby="confirm-new-message-description" tabIndex={-1}>
            <span className="eyebrow">{t("sending.retry.eyebrow")}</span>
            <h3 id="confirm-new-message-title">{t("sending.retry.title")}</h3>
            <p id="confirm-new-message-description">{t("sending.retry.description")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" onClick={() => setConfirmReplacement(null)}>{t("sending.retry.continue")}</button>
              <button className="primary-button" type="button" onClick={createReplacement}>{t("sending.retry.create")}</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
