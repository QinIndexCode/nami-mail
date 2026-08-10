import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { CircleAlert, LoaderCircle, MessageSquareX, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, ApiError } from "./api";
import { useI18n, type Translate } from "./i18n";
import ThemedSelect from "./ThemedSelect";
import type { Account, AutoReplyDecisionReason, AutoReplyDecisionRecord } from "./types";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";

type AutoReplyDecisionsDialogProps = {
  accounts: Account[];
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

const REASONS: readonly AutoReplyDecisionReason[] = [
  "screening",
  "scope",
  "low-value",
  "sensitive",
  "user-rejected",
  "daily-cap",
  "llm-failed",
  "send-failed",
  "no-template",
  "expired",
];

export function autoReplyDecisionReasonLabel(reason: AutoReplyDecisionReason, t: Translate): string {
  return t(`autoReply.decisions.reason.${reason}`);
}

function accountEmail(accounts: Account[], accountId: string): string | undefined {
  return accounts.find((account) => account.id === accountId)?.email;
}

function DecisionCard({ item, account, busy, onDelete, style }: {
  item: AutoReplyDecisionRecord;
  account?: string;
  busy: boolean;
  onDelete: () => void;
  style?: CSSProperties;
}) {
  const { t, formatDate } = useI18n();
  return (
    <article className="auto-reply-decision-item" role="listitem" style={style}>
      <div className="auto-reply-decision-meta">
        <span className={`auto-reply-decision-reason reason-${item.reason}`}>{autoReplyDecisionReasonLabel(item.reason, t)}</span>
        {item.fromAddress && <span className="auto-reply-decision-sender">{item.fromName ? `${item.fromName} <${item.fromAddress}>` : item.fromAddress}</span>}
        <time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>
      </div>
      {item.subject && <h3 className="auto-reply-decision-subject">{item.subject || t("autoReply.pending.untitled")}</h3>}
      {(item.detail || item.fromAddress) && <p className="auto-reply-decision-detail">{item.detail || item.fromAddress}</p>}
      <div className="auto-reply-decision-footer">
        <span className="auto-reply-decision-account">{account ?? t("autoReply.pending.removedAccount")}</span>
        <button
          className="icon-button auto-reply-decision-delete"
          type="button"
          disabled={busy}
          aria-label={t("autoReply.decisions.delete")}
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  );
}

/**
 * Review dialog for auto-reply declines and failures: every inbound message
 * the Agent did not answer, with the reason, sender and time, plus a reason
 * filter and free-text search. Records can be dismissed individually.
 */
export default function AutoReplyDecisionsDialog({ accounts, onClose, fallbackFocusRef }: AutoReplyDecisionsDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const [items, setItems] = useState<AutoReplyDecisionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reason, setReason] = useState<AutoReplyDecisionReason | "">("");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  useDialogFocus(true, dialogRef, { fallbackFocusRef });

  const { closing, requestClose } = useDismissTransition(onClose);

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const result = await api.autoReplyDecisions({
        ...(reason ? { reason } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
        limit: 200,
      });
      setItems(result.items);
    } catch (requestError) {
      setError(requestError instanceof ApiError
        ? requestError.message
        : t("autoReply.decisions.loadError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t, reason, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const deleteItem = async (id: string) => {
    setDeleting(id);
    setError(null);
    try {
      await api.autoReplyDecisionDelete(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (requestError) {
      setError(requestError instanceof ApiError
        ? requestError.message
        : t("autoReply.decisions.deleteError"));
    } finally {
      setDeleting(null);
    }
  };

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

  const reasonLabel = (value: AutoReplyDecisionReason | "") => value === "" ? t("autoReply.decisions.allReasons") : autoReplyDecisionReasonLabel(value, t);

  return (
    <div className={`modal-backdrop auto-reply-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section ref={dialogRef} className={`modal-card auto-reply-modal${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="auto-reply-decisions-title" tabIndex={-1}>
        <header className="modal-heading auto-reply-heading">
          <div><span className="eyebrow">{t("autoReply.decisions.eyebrow")}</span><h2 id="auto-reply-decisions-title">{t("autoReply.decisions.title")}</h2></div>
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

        <div className="auto-reply-decision-filters">
          <label className="auto-reply-decision-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={t("autoReply.decisions.searchPlaceholder")}
              aria-label={t("autoReply.decisions.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ThemedSelect
            id="auto-reply-decision-reason-filter"
            value={reason}
            aria-label={t("autoReply.decisions.reasonFilter")}
            onValueChange={(value) => setReason(value as AutoReplyDecisionReason | "")}
          >
            <option value="">{reasonLabel("")}</option>
            {REASONS.map((value) => (
              <option key={value} value={value}>{reasonLabel(value)}</option>
            ))}
          </ThemedSelect>
        </div>

        {error && <div className="form-status error auto-reply-error" role="alert"><CircleAlert size={16} />{error}</div>}

        <div className="auto-reply-list" role="list" aria-label={t("autoReply.decisions.listLabel")} aria-live="polite" aria-busy={loading}>
          {loading && items.length === 0 && (
            <div className="skeleton-stack" aria-hidden="true">
              <div className="skeleton-card" />
              <div className="skeleton-card" />
              <div className="skeleton-card" />
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="auto-reply-empty"><MessageSquareX size={26} /><h3>{t("autoReply.decisions.emptyTitle")}</h3><p>{t("autoReply.decisions.emptyDescription")}</p></div>
          )}
          {items.map((item, index) => (
            <DecisionCard
              key={item.id}
              item={item}
              account={accountEmail(accounts, item.accountId)}
              busy={deleting !== null}
              onDelete={() => void deleteItem(item.id)}
              style={{ animationDelay: `${Math.min(index * 32, 130)}ms` } satisfies CSSProperties}
            />
          ))}
        </div>
      </section>
    </div>
  );
}