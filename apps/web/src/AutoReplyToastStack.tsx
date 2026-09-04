import { useEffect, useState, type MouseEvent } from "react";
import { CheckCheck, CornerDownLeft, MessageSquareReply, ShieldAlert, X } from "lucide-react";
import { api } from "./api";
import type { DesktopAutoReplyNotice } from "./desktop";
import { desktopBridge } from "./desktop";
import { autoReplySenderLabel } from "./AutoReplyPendingDialog";
import { useI18n } from "./i18n";
import { useDismissTransition } from "./hooks/useDismissTransition";

const EXIT_DURATION_MS = 240;

type AutoReplyToastStackProps = {
  notices: readonly DesktopAutoReplyNotice[];
  onDismiss: (notice: DesktopAutoReplyNotice) => void;
  /** While a modal dialog is open the stack moves behind the scrim so it can
   *  never intercept clicks aimed at the dialog (e.g. the compose card). */
  behindModal?: boolean;
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
  const desktopAvailable = Boolean(desktopBridge()?.onAgentConfirmationResult);
  const [busy, setBusy] = useState(false);
  const [resolveFailed, setResolveFailed] = useState(false);
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
  const resolve = (confirmationId: string, decision: "approve" | "reject") => {
    setBusy(true);
    setResolveFailed(false);
    void api.resolveAgentConfirmation(confirmationId, decision)
      .then(() => requestClose())
      .catch(() => setResolveFailed(true))
      .finally(() => setBusy(false));
  };
  const cancel = (event: MouseEvent<HTMLButtonElement>) => {
    // In the desktop runtime the Electron preload handles the trusted click;
    // in a plain web session the rejection goes through the local API.
    if (notice.kind !== "pending" || desktopAvailable) {
      requestClose();
      return;
    }
    if (busy) return;
    event.preventDefault();
    resolve(notice.confirmationId, "reject");
  };
  const approve = (event: MouseEvent<HTMLButtonElement>) => {
    // Same split as cancel: the desktop preload resolves the approval natively,
    // while a plain web session approves through the local confirmation API.
    if (notice.kind !== "pending" || desktopAvailable) {
      requestClose();
      return;
    }
    if (busy) return;
    event.preventDefault();
    resolve(notice.confirmationId, "approve");
  };
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
      {resolveFailed && (
        <p className="auto-reply-toast-error" role="alert">{t("autoReply.notice.resolveFailed")}</p>
      )}
      <footer className="auto-reply-toast-footer">
        <span className="auto-reply-toast-sender">
          {notice.kind === "pending"
            ? autoReplySenderLabel(notice.fromName, notice.fromAddress)
            : autoReplySenderLabel(notice.toName, notice.toAddress)}
        </span>
        {notice.kind === "pending" && (
          <>
            <button
              className="auto-reply-toast-send"
              type="button"
              data-nami-agent-confirmation-id={notice.confirmationId}
              data-nami-agent-confirmation-decision="approve"
              onClick={approve}
              disabled={busy}
            >
              <CheckCheck size={14} />{t("autoReply.pending.approve")}
            </button>
            <button
              className="auto-reply-toast-cancel"
              type="button"
              data-nami-agent-confirmation-id={notice.confirmationId}
              data-nami-agent-confirmation-decision="reject"
              onClick={cancel}
              disabled={busy}
            >
              {t("autoReply.notice.cancel")}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

export function AutoReplyToastStack({ notices, onDismiss, behindModal = false }: AutoReplyToastStackProps) {
  return (
    <div className={`auto-reply-toast-stack${behindModal ? " behind-modal" : ""}`} role="status" aria-live="polite">
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