import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { CalendarClock, Check, ChevronLeft, ChevronRight, CircleAlert, Eye, LoaderCircle, Mail, PenLine, RefreshCw, Send, X } from "lucide-react";
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
import { useDismissTransition } from "./useDismissTransition";
import { useStablePagedListHeight } from "./useStablePagedListHeight";

type SendingStatusModalProps = {
  accounts: Account[];
  submissions: OutboundSubmission[];
  loading: boolean;
  loadError: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onSyncAccount: (accountId: string) => Promise<void>;
  onCreateNewMessage: (draft: { accountId: string; to?: string; subject?: string }) => void;
  onCancelScheduled: (submissionId: string) => Promise<void>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
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

function statusIcon(deliveryStatus: OutboundSubmission["deliveryStatus"]): ReactNode {
  if (deliveryStatus === "submitting") return <LoaderCircle className="spin" size={13} />;
  if (deliveryStatus === "confirmed") return <Check size={13} />;
  if (deliveryStatus === "failed") return <X size={13} />;
  if (deliveryStatus === "unknown_delivery") return <CircleAlert size={13} />;
  return <Send size={13} />;
}

const FILTER_OPTIONS = ["all", "active", "attention", "confirmed"] as const;
type SubmissionFilter = (typeof FILTER_OPTIONS)[number];

/** Matches the per-page size used by the contacts/templates management lists. */
const SUBMISSIONS_PER_PAGE = 5;

export default function SendingStatusModal({
  accounts,
  submissions,
  loading,
  loadError,
  onClose,
  onRefresh,
  onSyncAccount,
  onCreateNewMessage,
  onCancelScheduled,
  fallbackFocusRef,
}: SendingStatusModalProps) {
  const { formatDate, t } = useI18n();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Readonly<Record<string, string>>>({});
  const [confirmReplacement, setConfirmReplacement] = useState<OutboundSubmission | null>(null);
  const [detailsSubmission, setDetailsSubmission] = useState<OutboundSubmission | null>(null);
  const [filter, setFilter] = useState<SubmissionFilter>("all");
  const [page, setPage] = useState(1);
  const dialogRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const counts = useMemo(() => ({
    all: submissions.length,
    active: submissions.filter((item) => ["pending", "submitting", "submitted"].includes(item.deliveryStatus)).length,
    attention: submissions.filter((item) => ["unknown_delivery", "failed"].includes(item.deliveryStatus)).length,
    confirmed: submissions.filter((item) => item.deliveryStatus === "confirmed").length,
  }), [submissions]);
  const visibleSubmissions = useMemo(() => {
    if (filter === "all") return submissions;
    if (filter === "active") return submissions.filter((item) => ["pending", "submitting", "submitted"].includes(item.deliveryStatus));
    if (filter === "attention") return submissions.filter((item) => ["unknown_delivery", "failed"].includes(item.deliveryStatus));
    return submissions.filter((item) => item.deliveryStatus === "confirmed");
  }, [filter, submissions]);
  // Pagination mirrors the management lists (5 rows per page). The page is
  // re-clamped whenever the filtered set shrinks (e.g. after a refresh).
  const pageCount = Math.max(1, Math.ceil(visibleSubmissions.length / SUBMISSIONS_PER_PAGE));
  const clampedPage = Math.min(page, pageCount);
  const showToolbar = visibleSubmissions.length > SUBMISSIONS_PER_PAGE;
  const pageSubmissions = useMemo(() => {
    if (!showToolbar) return visibleSubmissions;
    const start = (clampedPage - 1) * SUBMISSIONS_PER_PAGE;
    return visibleSubmissions.slice(start, start + SUBMISSIONS_PER_PAGE);
  }, [visibleSubmissions, showToolbar, clampedPage]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  // Keep the modal footprint stable: while the pager is visible every page has
  // the same row count, so pin the list viewport and let only its content change.
  const listScroll = useStablePagedListHeight<HTMLDivElement>(showToolbar);

  const runRecordAction = async (submission: OutboundSubmission, action: () => Promise<void>) => {
    if (busyIds.has(submission.id)) return;
    setBusyIds((current) => new Set(current).add(submission.id));
    setActionErrors((current) => {
      if (!current[submission.id]) return current;
      const next = { ...current };
      delete next[submission.id];
      return next;
    });
    try {
      await action();
    } catch (error) {
      setActionErrors((current) => ({ ...current, [submission.id]: mailErrorToastMessage(error, t("sending.error.recordAction"), t) }));
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(submission.id);
        return next;
      });
    }
  };

  useDialogFocus(true, dialogRef, { fallbackFocusRef, suspended: Boolean(confirmReplacement) || Boolean(detailsSubmission) });
  useDialogFocus(Boolean(confirmReplacement), confirmationRef, { fallbackFocusRef: dialogRef });
  useDialogFocus(Boolean(detailsSubmission), detailsRef, { fallbackFocusRef: dialogRef, suspended: Boolean(confirmReplacement) });
  const { closing, requestClose } = useDismissTransition(onClose);
  const { closing: confirmClosing, requestClose: requestConfirmClose, reset: resetConfirmClosing } = useDismissTransition(() => setConfirmReplacement(null));
  const { closing: detailsClosing, requestClose: requestDetailsClose } = useDismissTransition(() => setDetailsSubmission(null));

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (detailsSubmission) {
        requestDetailsClose();
        return;
      }
      if (confirmReplacement) {
        requestConfirmClose();
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [detailsSubmission, confirmReplacement, requestClose, requestConfirmClose, requestDetailsClose]);

  const refresh = async () => {
    if (loading) return;
    setRefreshError(null);
    try {
      await onRefresh();
    } catch (error) {
      setRefreshError(mailErrorToastMessage(error, t("sending.error.refresh"), t));
    }
  };

  const syncSent = async (submission: OutboundSubmission) => {
    await runRecordAction(submission, async () => {
      await onSyncAccount(submission.accountId);
      await onRefresh();
    });
  };

  const cancelScheduled = async (submission: OutboundSubmission) => {
    await runRecordAction(submission, async () => {
      await onCancelScheduled(submission.id);
    });
  };

  const createReplacement = () => {
    if (!confirmReplacement) return;
    const draft = newMessageDraftFromSubmission(confirmReplacement);
    setConfirmReplacement(null);
    onCreateNewMessage(draft);
  };

  const openDetails = (submission: OutboundSubmission) => {
    setDetailsSubmission(submission);
  };

  const closeDetails = () => {
    requestDetailsClose();
  };

  return (
    <>
      <div className={`modal-backdrop sending-status-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !confirmReplacement && !detailsSubmission) requestClose();
      }}>
        <section ref={dialogRef} className={`modal-card sending-status-modal${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="sending-status-title" tabIndex={-1}>
          <header className="modal-heading management-heading sending-status-heading">
            <div>
              <span className="eyebrow">{t("sending.modal.eyebrow")}</span>
              <h2 id="sending-status-title">{t("sending.modal.title")}</h2>
              <p className="management-heading-description">{t("sending.modal.description")}</p>
            </div>
            <div className="sending-status-heading-actions">
              <button className="icon-button" type="button" aria-label={t("sending.modal.refreshTooltip")} data-tooltip={t("sending.modal.refreshTooltip")} disabled={loading} onClick={() => void refresh()}>
                {loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              </button>
              <button className="icon-button" type="button" aria-label={t("sending.modal.closeTooltip")} data-tooltip={t("sending.modal.closeTooltip")} onClick={requestClose}>
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="sending-status-filter" role="group" aria-label={t("sending.modal.overviewLabel")}>
            {FILTER_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className="source-filter-button"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                  setPage(1);
                }}
              >
                {t(`sending.modal.${value}`)}
                <span className={`source-filter-count${value === "attention" && counts.attention ? " attention" : ""}`}>{counts[value]}</span>
              </button>
            ))}
          </div>

          {(refreshError || loadError) && <div className="form-status error sending-status-error" role="alert"><CircleAlert size={16} />{refreshError || loadError}</div>}

          <div ref={listScroll.ref} className="sending-status-list" style={listScroll.style} role="list" aria-label={t("sending.modal.listLabel")} aria-live="polite" aria-busy={loading}>
            {loading && submissions.length === 0 && (
              <div className="skeleton-stack" aria-hidden="true">
                <div className="skeleton-card" />
                <div className="skeleton-card" />
                <div className="skeleton-card" />
              </div>
            )}
            {!loading && visibleSubmissions.length === 0 && <div className="sending-status-empty"><Mail size={26} /><h3>{filter === "all" ? t("sending.modal.emptyTitle") : t("sending.modal.filteredEmptyTitle")}</h3><p>{filter === "all" ? t("sending.modal.emptyDescription") : t("sending.modal.filteredEmptyDescription")}</p></div>}
            {pageSubmissions.map((submission) => {
              const presentation = submissionStatusPresentation(submission.deliveryStatus, t);
              const account = accountById.get(submission.accountId);
              const recipients = recipientSummary(submission.recipients, 3, t);
              const fullRecipients = recipientSummary(submission.recipients, Number.MAX_SAFE_INTEGER, t) ?? t("sending.modal.recipientsMissing");
              const title = submission.subject === undefined || submission.subject === null
                ? t("sending.modal.recordTitle", { id: submissionMessageIdSuffix(submission.messageId) })
                : submission.subject || t("sending.modal.untitled");
              const canSync = submission.deliveryStatus === "unknown_delivery" || submission.deliveryStatus === "submitted";
              const canCreate = submission.deliveryStatus === "unknown_delivery" || submission.deliveryStatus === "failed";
              const isPendingScheduled = submission.deliveryStatus === "pending" && Boolean(submission.sendAt);
              const isOverdueScheduled = isPendingScheduled && submission.sendAt !== null && new Date(submission.sendAt).getTime() < Date.now();
              const statusMessage = submissionNoticeMessage(submission, t);
              const recordBusy = busyIds.has(submission.id);
              const actionError = actionErrors[submission.id];
              return (
                <div className={`sending-status-row tone-${presentation.tone}`} key={submission.id} role="listitem">
                  <div className="sending-status-row-main">
                    <span className={`sending-status-dot tone-${presentation.tone}`} aria-hidden="true" />
                    <div className="sending-status-row-copy">
                      <strong className="sending-status-row-title">{title}</strong>
                      {recipients && <small className="sending-status-row-recipients">{t("sending.modal.recipientsValue", { recipients })}</small>}
                      <small className="sending-status-row-detail">{presentation.detail}</small>
                      {isPendingScheduled && submission.sendAt && (
                        <small className="sending-status-row-scheduled"><CalendarClock size={12} />{t("sending.modal.scheduledTime", { time: formatSubmissionTime(submission.sendAt, formatDate, t) })}</small>
                      )}
                      {isOverdueScheduled && (
                        <small className="sending-status-row-overdue"><CircleAlert size={12} />{t("sending.modal.overdueScheduled")}</small>
                      )}
                      {statusMessage && <small className="sending-status-row-message">{statusMessage}</small>}
                      {actionError && <small className="sending-status-row-action-error" role="alert"><CircleAlert size={12} />{actionError}</small>}
                    </div>
                    <time dateTime={submission.updatedAt} className="sending-status-row-time">{formatSubmissionTime(submission.updatedAt, formatDate, t)}</time>
                    <div className="sending-status-row-actions">
                      <button className="icon-button" type="button" aria-label={t("sending.modal.viewDetails", { title })} data-tooltip={t("sending.modal.viewDetails", { title })} onClick={() => openDetails(submission)}>
                        <Eye size={15} />
                      </button>
                      {canSync && <button className="secondary-button" type="button" onClick={() => void syncSent(submission)} disabled={recordBusy}>{recordBusy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t("sending.modal.syncSent")}</button>}
                      {canCreate && <button className="secondary-button" type="button" onClick={() => { if (submission.deliveryStatus === "unknown_delivery") { resetConfirmClosing(); setConfirmReplacement(submission); } else onCreateNewMessage(newMessageDraftFromSubmission(submission)); }} disabled={recordBusy}><PenLine size={14} />{t("sending.modal.createRetryDraft")}</button>}
                      {isPendingScheduled && <button className="secondary-button" type="button" onClick={() => void cancelScheduled(submission)} disabled={recordBusy}>{recordBusy ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}{t("sending.modal.cancelScheduled")}</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {showToolbar && (
            <div className="sending-status-pager">
              <button className="secondary-button" type="button" disabled={clampedPage <= 1} onClick={() => setPage(clampedPage - 1)} aria-label={t("sending.modal.pagerPrevious")}>
                <ChevronLeft size={15} />{t("sending.modal.pagerPrevious")}
              </button>
              <span className="sending-status-pager-status" role="status">{t("sending.modal.pagerLabel", { page: clampedPage, total: pageCount })}</span>
              <button className="secondary-button" type="button" disabled={clampedPage >= pageCount} onClick={() => setPage(clampedPage + 1)} aria-label={t("sending.modal.pagerNext")}>
                {t("sending.modal.pagerNext")}<ChevronRight size={15} />
              </button>
            </div>
          )}
        </section>
      </div>

      {detailsSubmission && (
        <div className={`modal-backdrop sending-status-details-backdrop${detailsClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !confirmReplacement) closeDetails();
        }}>
          <section ref={detailsRef} className={`sending-status-details-modal${detailsClosing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={t("sending.modal.detailsLabel")} aria-labelledby="sending-status-details-title" tabIndex={-1}>
            <div className="sending-status-details">
              <div className="sending-status-details-head">
                <span className="contact-editor-avatar" aria-hidden="true">{statusIcon(detailsSubmission.deliveryStatus)}</span>
                <div>
                  <span className="eyebrow">{t("sending.modal.detailsEyebrow")}</span>
                  <h3 id="sending-status-details-title" className="contact-editor-title">
                    {detailsSubmission.subject === undefined || detailsSubmission.subject === null
                      ? t("sending.modal.recordTitle", { id: submissionMessageIdSuffix(detailsSubmission.messageId) })
                      : detailsSubmission.subject || t("sending.modal.untitled")}
                  </h3>
                  <small className="sending-status-details-account">{accountById.get(detailsSubmission.accountId)?.email ?? t("sending.modal.removedAccount")}</small>
                </div>
                <button className="icon-button" type="button" aria-label={t("sending.modal.closeTooltip")} data-tooltip={t("sending.modal.closeTooltip")} onClick={closeDetails}>
                  <X size={18} />
                </button>
              </div>
              <dl className="sending-status-details-fields">
                {(() => {
                  const detailsPresentation = submissionStatusPresentation(detailsSubmission.deliveryStatus, t);
                  const detailsRecipients = recipientSummary(detailsSubmission.recipients, Number.MAX_SAFE_INTEGER, t) ?? t("sending.modal.recipientsMissing");
                  return (
                    <>
                      <div><dt>{t("sending.modal.statusLabel")}</dt><dd><span className={`sending-status-badge tone-${detailsPresentation.tone}`}>{statusIcon(detailsSubmission.deliveryStatus)}{detailsPresentation.label}</span></dd></div>
                      <div><dt>{t("sending.modal.detailLabel")}</dt><dd>{detailsPresentation.detail}</dd></div>
                      <div><dt>{t("sending.modal.subject")}</dt><dd>{detailsSubmission.subject === undefined || detailsSubmission.subject === null ? t("sending.modal.untitled") : detailsSubmission.subject}</dd></div>
                      <div><dt>{t("sending.modal.recipientsLabel")}</dt><dd>{detailsRecipients}</dd></div>
                      <div><dt>{t("sending.modal.account")}</dt><dd>{accountById.get(detailsSubmission.accountId)?.email ?? t("sending.modal.removedAccount")}</dd></div>
                      <div><dt>{t("sending.modal.messageId")}</dt><dd><code>{detailsSubmission.messageId}</code></dd></div>
                      {detailsSubmission.sendAt && (
                        <div><dt>{t("sending.modal.scheduledLabel")}</dt><dd><CalendarClock size={12} />{formatSubmissionTime(detailsSubmission.sendAt, formatDate, t)}</dd></div>
                      )}
                      {detailsSubmission.submittedAt && (
                        <div><dt>{t("sending.modal.submittedLabel")}</dt><dd>{formatSubmissionTime(detailsSubmission.submittedAt, formatDate, t)}</dd></div>
                      )}
                      {detailsSubmission.confirmedAt && (
                        <div><dt>{t("sending.modal.confirmedLabel")}</dt><dd>{formatSubmissionTime(detailsSubmission.confirmedAt, formatDate, t)}</dd></div>
                      )}
                      <div><dt>{t("sending.modal.updatedLabel")}</dt><dd>{formatSubmissionTime(detailsSubmission.updatedAt, formatDate, t)}</dd></div>
                    </>
                  );
                })()}
              </dl>
              {submissionNoticeMessage(detailsSubmission, t) && (
                <div className="sending-status-details-message" role="alert"><CircleAlert size={14} />{submissionNoticeMessage(detailsSubmission, t)}</div>
              )}
              {actionErrors[detailsSubmission.id] && (
                <div className="sending-status-details-action-error" role="alert"><CircleAlert size={14} />{actionErrors[detailsSubmission.id]}</div>
              )}
              <div className="sending-status-details-actions">
                <button className="secondary-button" type="button" onClick={closeDetails}>{t("sending.modal.closeDetails")}</button>
                {(() => {
                  const detailsCanSync = detailsSubmission.deliveryStatus === "unknown_delivery" || detailsSubmission.deliveryStatus === "submitted";
                  const detailsCanCreate = detailsSubmission.deliveryStatus === "unknown_delivery" || detailsSubmission.deliveryStatus === "failed";
                  const detailsPendingScheduled = detailsSubmission.deliveryStatus === "pending" && Boolean(detailsSubmission.sendAt);
                  const detailsBusy = busyIds.has(detailsSubmission.id);
                  return (
                    <>
                      {detailsCanSync && <button className="secondary-button" type="button" onClick={() => void syncSent(detailsSubmission)} disabled={detailsBusy}>{detailsBusy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t("sending.modal.syncSent")}</button>}
                      {detailsCanCreate && <button className="secondary-button" type="button" onClick={() => { if (detailsSubmission.deliveryStatus === "unknown_delivery") { resetConfirmClosing(); setConfirmReplacement(detailsSubmission); } else onCreateNewMessage(newMessageDraftFromSubmission(detailsSubmission)); }} disabled={detailsBusy}><PenLine size={14} />{t("sending.modal.createRetryDraft")}</button>}
                      {detailsPendingScheduled && <button className="secondary-button" type="button" onClick={() => void cancelScheduled(detailsSubmission)} disabled={detailsBusy}>{detailsBusy ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}{t("sending.modal.cancelScheduled")}</button>}
                    </>
                  );
                })()}
              </div>
            </div>
          </section>
        </div>
      )}

      {confirmReplacement && (
        <div className={`modal-backdrop confirmation-backdrop sending-status-confirmation-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestConfirmClose();
        }}>
          <section ref={confirmationRef} className={`confirmation-card sending-status-confirmation${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-new-message-title" aria-describedby="confirm-new-message-description" tabIndex={-1}>
            <span className="eyebrow">{t("sending.retry.eyebrow")}</span>
            <h3 id="confirm-new-message-title">{t("sending.retry.title")}</h3>
            <p id="confirm-new-message-description">{t("sending.retry.description")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" onClick={requestConfirmClose}>{t("sending.retry.continue")}</button>
              <button className="primary-button" type="button" onClick={createReplacement}>{t("sending.retry.create")}</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
