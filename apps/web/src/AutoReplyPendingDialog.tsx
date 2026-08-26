import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { CheckCheck, CircleAlert, LoaderCircle, MessageSquareReply, RefreshCw, ShieldAlert, X } from "lucide-react";
import { api, ApiError } from "./api";
import type { AutoReplyPendingSummary } from "./agentTypes";
import { desktopBridge } from "./desktop";
import { useI18n } from "./i18n";
import type { Account } from "./types";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";

type AutoReplyPendingDialogProps = {
  accounts: Account[];
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

const POLL_INTERVAL_MS = 20_000;

function accountEmail(accounts: Account[], accountId: string): string | undefined {
  return accounts.find((account) => account.id === accountId)?.email;
}

export function autoReplySenderLabel(fromName: string, fromAddress: string): string {
  return fromName ? `${fromName} <${fromAddress}>` : fromAddress;
}

/** One drafted auto-reply awaiting confirmation; shared with tests via SSR. */
export function AutoReplyPendingCard({
  item,
  accountEmail: account,
  canResolve,
  onResolve,
  style,
}: {
  item: AutoReplyPendingSummary;
  accountEmail?: string;
  canResolve: boolean;
  onResolve: (confirmationId: string, decision: "approve" | "reject") => void;
  style?: React.CSSProperties;
}) {
  const { t, formatDate } = useI18n();
  return (
    <article className="auto-reply-item" role="listitem" style={style}>
      <div className="auto-reply-item-meta">
        <span className="auto-reply-item-sender">{autoReplySenderLabel(item.fromName, item.fromAddress)}</span>
        {item.sensitive && <span className="auto-reply-sensitive-badge"><ShieldAlert size={12} />{t("autoReply.pending.sensitive")}</span>}
        <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
      </div>
      <h3 className="auto-reply-item-subject">{item.subject || t("autoReply.pending.untitled")}</h3>
      <p className="auto-reply-item-reply">{item.preview.summary}</p>
      {item.preview.fields.length > 0 && (
        <dl className="auto-reply-item-fields">
          {item.preview.fields.map((field) => (
            <div key={`${field.label}:${field.value}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>
          ))}
        </dl>
      )}
      <div className="auto-reply-item-footer">
        <span className="auto-reply-item-account">{account ?? t("autoReply.pending.removedAccount")}</span>
        <small className="auto-reply-item-expiry">{t("autoReply.pending.expires", { time: formatDate(item.expiresAt) })}</small>
        <div className="auto-reply-item-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={!canResolve}
            data-nami-agent-confirmation-id={item.confirmationId}
            data-nami-agent-confirmation-decision="reject"
            onClick={() => onResolve(item.confirmationId, "reject")}
          >
            {t("agent.confirmation.reject")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!canResolve}
            data-nami-agent-confirmation-id={item.confirmationId}
            data-nami-agent-confirmation-decision="approve"
            onClick={() => onResolve(item.confirmationId, "approve")}
          >
            <CheckCheck size={15} />{t("autoReply.pending.approve")}
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * Reviews auto-replies the Agent drafted for incoming mail. Approve/Reject
 * buttons reuse the desktop confirmation attributes so the Electron preload
 * resolves each decision natively when a bridge is present; in a plain web
 * session the decision is resolved through the local confirmation API and the
 * dialog refreshes so approved replies disappear as the engine sends them.
 */
export default function AutoReplyPendingDialog({ accounts, onClose, fallbackFocusRef }: AutoReplyPendingDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const refreshInFlightRef = useRef(false);
  const [items, setItems] = useState<AutoReplyPendingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  useDialogFocus(true, dialogRef, { fallbackFocusRef });

  const bridge = desktopBridge();
  const desktopAvailable = Boolean(bridge?.onAgentConfirmationResult);
  // The desktop preload resolves decisions natively; otherwise the local web
  // surface resolves them through the confirmation API.
  const canResolve = desktopAvailable || !bridge;
  const { closing, requestClose } = useDismissTransition(onClose);

  const refresh = useCallback(async () => {
    // A refresh that outlives the poll interval races its successor; the
    // slower response would then overwrite fresher items. Skip while running.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setError(null);
    setRefreshing(true);
    try {
      const result = await api.autoReplyPending();
      setItems(result.items);
    } catch (requestError) {
      setError(requestError instanceof ApiError
        ? requestError.message
        : t("autoReply.pending.loadError"));
    } finally {
      refreshInFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  const resolve = useCallback(async (confirmationId: string, decision: "approve" | "reject") => {
    // In the desktop runtime the Electron preload handles the trusted click
    // itself; React must not double-resolve the confirmation.
    if (desktopAvailable || resolving) return;
    setResolving(confirmationId);
    try {
      await api.resolveAgentConfirmation(confirmationId, decision);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof ApiError
        ? requestError.message
        : t("autoReply.pending.loadError"));
    } finally {
      setResolving(null);
    }
  }, [desktopAvailable, refresh, resolving, t]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onAgentConfirmationResult) return;
    return bridge.onAgentConfirmationResult(() => {
      void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [requestClose]);

  return (
    <div className={`modal-backdrop auto-reply-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section ref={dialogRef} className={`modal-card auto-reply-modal${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="auto-reply-pending-title" tabIndex={-1}>
        <header className="modal-heading auto-reply-heading">
          <div><span className="eyebrow">{t("autoReply.pending.eyebrow")}</span><h2 id="auto-reply-pending-title">{t("autoReply.pending.title")}</h2></div>
          <div className="auto-reply-heading-actions">
            <span className="app-tooltip app-tooltip-icon">
              <button className="icon-button" type="button" aria-label={t("autoReply.pending.refreshTooltip")} onClick={() => void refresh()} disabled={loading || refreshing}>
                {refreshing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              </button>
              <span className="app-tooltip-content" role="tooltip">{t("autoReply.pending.refreshTooltip")}</span>
            </span>
            <span className="app-tooltip app-tooltip-icon">
              <button className="icon-button" type="button" aria-label={t("autoReply.pending.closeTooltip")} onClick={requestClose}><X size={18} /></button>
              <span className="app-tooltip-content" role="tooltip">{t("autoReply.pending.closeTooltip")}</span>
            </span>
          </div>
        </header>

        {!canResolve && (
          <div className="form-status warning auto-reply-warning" role="status"><CircleAlert size={16} />{t("autoReply.pending.desktopOnly")}</div>
        )}
        {error && <div className="form-status error auto-reply-error" role="alert"><CircleAlert size={16} />{error}</div>}

        <div className="auto-reply-list" role="list" aria-label={t("autoReply.pending.listLabel")} aria-live="polite" aria-busy={loading}>
          {loading && items.length === 0 && (
            <div className="skeleton-stack" aria-hidden="true">
              <div className="skeleton-card" />
              <div className="skeleton-card" />
              <div className="skeleton-card" />
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="auto-reply-empty"><MessageSquareReply size={26} /><h3>{t("autoReply.pending.emptyTitle")}</h3><p>{t("autoReply.pending.emptyDescription")}</p></div>
          )}
          {items.map((item, index) => (
            <AutoReplyPendingCard
              key={item.confirmationId}
              item={item}
              accountEmail={accountEmail(accounts, item.accountId)}
              canResolve={canResolve}
              onResolve={(confirmationId, decision) => void resolve(confirmationId, decision)}
              style={{ animationDelay: `${Math.min(index * 32, 130)}ms` } satisfies CSSProperties}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
