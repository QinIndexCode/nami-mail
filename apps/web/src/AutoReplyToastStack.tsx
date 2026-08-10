import { useEffect } from "react";
import { CornerDownLeft, MessageSquareReply, ShieldAlert, X } from "lucide-react";
import type { DesktopAutoReplyNotice } from "./desktop";
import { autoReplySenderLabel } from "./AutoReplyPendingDialog";
import { useI18n } from "./i18n";
import { useDismissTransition } from "./useDismissTransition";

const EXIT_DURATION_MS = 240;

type AutoReplyToastStackProps = {
  notices: readonly DesktopAutoReplyNotice[];
  onDismiss: (notice: DesktopAutoReplyNotice) => void;
};

/**
 * Stable identity for a notice. Pending drafts are unique by confirmation;
 * sent replies are unique by the message they answered.
 */
export function autoReplyNoticeKey(notice: DesktopAutoReplyNotice): string {
  return notice.kind === "pending" ? `pending:${notice.confirmationId}` : `sent:${notice.messageId}`;
}

function AutoReplyToastItem({
  notice,
  onDismiss,
}: {
  notice: DesktopAutoReplyNotice;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const { closing, requestClose } = useDismissTransition(onDismiss, EXIT_DURATION_MS);
  const cardAttributes = notice.kind === "pending"
    ? {
      "data-nami-agent-confirmation-card": "",
      "data-nami-agent-confirmation-id": notice.confirmationId,
    }
    : {};
  useEffect(() => {
    if (notice.kind !== "pending" || closing) return undefined;
    // The confirmation dies at its TTL; the popup has no valid action left
    // and must not linger with a dead cancel button.
    const remaining = Math.max(0, Date.parse(notice.expiresAt) - Date.now());
    const timer = window.setTimeout(requestClose, remaining);
    return () => window.clearTimeout(timer);
  }, [closing, notice, requestClose]);
  return (
    <article
      className={`auto-reply-toast${closing ? " closing" : ""}`}
      {...cardAttributes}
      aria-labelledby={`auto-reply-toast-title-${autoReplyNoticeKey(notice)}`}
    >
      <header className="auto-reply-toast-heading">
        <span className="auto-reply-toast-icon" aria-hidden="true">
          {notice.kind === "pending" ? <MessageSquareReply size={17} /> : <CornerDownLeft size={17} />}
        </span>
        <div className="auto-reply-toast-heading-text">
          <span className="eyebrow">{notice.kind === "pending" ? t("autoReply.notice.pendingEyebrow") : t("autoReply.notice.sentEyebrow")}</span>
          <h3 id={`auto-reply-toast-title-${autoReplyNoticeKey(notice)}`}>
            {notice.kind === "pending" ? t("autoReply.notice.pendingTitle") : t("autoReply.notice.sentTitle")}
          </h3>
        </div>
        {notice.kind === "pending" && notice.sensitive && (
          <span className="auto-reply-sensitive-badge auto-reply-toast-sensitive">
            <ShieldAlert size={12} />
            {t("autoReply.pending.sensitive")}
          </span>
        )}
        <button className="auto-reply-toast-dismiss" type="button" aria-label={t("common.closeNotification")} data-tooltip={t("common.closeNotification")} onClick={requestClose}>
          <X size={15} />
        </button>
      </header>
      <p className="auto-reply-toast-subject">{notice.subject || t("autoReply.pending.untitled")}</p>
      <p className="auto-reply-toast-reply">{notice.replyPreview}</p>
      <footer className="auto-reply-toast-footer">
        <span className="auto-reply-toast-sender">
          {notice.kind === "pending"
            ? autoReplySenderLabel(notice.fromName, notice.fromAddress)
            : autoReplySenderLabel(notice.toName, notice.toAddress)}
        </span>
        {notice.kind === "pending" && (
          <button
            className="auto-reply-toast-cancel"
            type="button"
            data-nami-agent-confirmation-id={notice.confirmationId}
            data-nami-agent-confirmation-decision="reject"
            onClick={requestClose}
          >
            {t("autoReply.notice.cancel")}
          </button>
        )}
      </footer>
    </article>
  );
}

export function AutoReplyToastStack({ notices, onDismiss }: AutoReplyToastStackProps) {
  return (
    <div className="auto-reply-toast-stack" role="status" aria-live="polite">
      {notices.map((notice) => (
        <AutoReplyToastItem
          key={autoReplyNoticeKey(notice)}
          notice={notice}
          onDismiss={() => onDismiss(notice)}
        />
      ))}
    </div>
  );
}