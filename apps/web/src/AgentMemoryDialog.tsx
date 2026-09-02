import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type RefObject } from "react";
import { BookOpen, Check, CircleAlert, FileText, LoaderCircle, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, ApiError } from "./api";
import type { AgentMemoryKind, AgentMemoryRecord } from "./agentTypes";
import { useI18n, type Translate } from "./i18n";
import ThemedSelect from "./ThemedSelect";
import type { Account } from "./types";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useDismissTransition } from "./hooks/useDismissTransition";

type AgentMemoryDialogProps = {
  accounts: Account[];
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

const memoryKinds: readonly AgentMemoryKind[] = [
  "auto-reply-sent",
  "auto-reply-ignored",
  "email-sent",
  "calendar-created",
  "calendar-updated",
  "calendar-deleted",
  "note",
];

function accountEmail(accounts: Account[], accountId: string | undefined): string | undefined {
  if (!accountId) return undefined;
  return accounts.find((account) => account.id === accountId)?.email;
}

type MemoryFilters = {
  kind: "" | AgentMemoryKind;
  accountId: string;
  query: string;
};

const emptyFilters: MemoryFilters = { kind: "", accountId: "", query: "" };

export function memoryKindLabel(kind: AgentMemoryKind, t: Translate): string {
  return t(`agentMemory.kind.${kind}`);
}

export type AgentMemoryItemCardProps = {
  record: AgentMemoryRecord;
  accountEmail?: string;
  editing: boolean;
  editDraft: string;
  busy: boolean;
  armedDelete: boolean;
  leaving?: boolean;
  style?: CSSProperties;
  onStartEdit: () => void;
  onEditDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onArmDelete: () => void;
  onDisarmDelete: () => void;
  onDelete: () => void;
};

/** One memory record; exported so presentation tests can render it directly. */
export function AgentMemoryItemCard({
  record,
  accountEmail: account,
  editing,
  editDraft,
  busy,
  armedDelete,
  leaving = false,
  style,
  onStartEdit,
  onEditDraftChange,
  onSaveEdit,
  onCancelEdit,
  onArmDelete,
  onDisarmDelete,
  onDelete,
}: AgentMemoryItemCardProps) {
  const { t, formatDate } = useI18n();
  const deleting = busy;
  return (
    <article className={`agent-memory-item${leaving ? " leaving" : ""}`} role="listitem" style={style}>
      <div className="agent-memory-item-meta">
        <span className="agent-memory-kind-badge">{memoryKindLabel(record.kind, t)}</span>
        {account && <span className="agent-memory-item-account">{account}</span>}
        <time dateTime={record.occurredAt}>{formatDate(record.occurredAt)}</time>
      </div>
      {editing ? (
        <div className="agent-memory-edit">
          <input
            type="text"
            value={editDraft}
            maxLength={500}
            autoComplete="off"
            aria-label={t("agentMemory.editPlaceholder")}
            disabled={busy}
            onChange={(event) => onEditDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSaveEdit();
              if (event.key === "Escape") onCancelEdit();
            }}
          />
          <button className="primary-button" type="button" disabled={busy || !editDraft.trim()} onClick={onSaveEdit}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("agentMemory.save")}
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={onCancelEdit}>{t("common.cancel")}</button>
        </div>
      ) : (
        <>
          <h3 className="agent-memory-item-summary">{record.summary}</h3>
          {record.detail && <p className="agent-memory-item-detail"><FileText size={13} />{record.detail}</p>}
        </>
      )}
      <div className="agent-memory-item-actions">
        {armedDelete ? (
          <>
            <button className="secondary-button danger-button" type="button" disabled={busy} onClick={onDelete}>
              {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("agentMemory.confirmDelete")}
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={onDisarmDelete}>{t("common.cancel")}</button>
          </>
        ) : (
          <>
            <button className="icon-button" type="button" aria-label={t("agentMemory.edit")} disabled={busy} onClick={onStartEdit}>
              <Pencil size={14} />
            </button>
            <button className="icon-button danger-icon-button" type="button" aria-label={t("agentMemory.delete")} disabled={busy} onClick={onArmDelete}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * Long-term Agent memory is user-owned: everything the Agent remembers about
 * sent mail, auto-replies and calendar actions can be inspected, edited and
 * deleted here. Edits go straight to the local service's encrypted store.
 */
export default function AgentMemoryDialog({ accounts, onClose, fallbackFocusRef }: AgentMemoryDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const [filters, setFilters] = useState<MemoryFilters>(emptyFilters);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<AgentMemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState(false);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set());
  const clearConfirmationRef = useRef<HTMLElement>(null);
  const { closing, requestClose } = useDismissTransition(onClose);
  const { closing: clearClosing, requestClose: requestClearClose, reset: resetClearClosing } = useDismissTransition(() => setPendingClear(false));
  useDialogFocus(true, dialogRef, { fallbackFocusRef, suspended: pendingClear });
  useDialogFocus(pendingClear, clearConfirmationRef, { fallbackFocusRef: dialogRef });

  const busy = Boolean(busyId);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (pendingClear) {
        requestClearClose();
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [requestClose, requestClearClose, pendingClear]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.query), 300);
    return () => window.clearTimeout(timer);
  }, [filters.query]);

  const load = async (keepItems = false) => {
    setError(null);
    if (!keepItems) setLoading(true);
    try {
      const result = await api.agentMemory({
        kind: filters.kind || undefined,
        accountId: filters.accountId || undefined,
        query: debouncedQuery || undefined,
        limit: 200,
      });
      setItems(result.items);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t("agentMemory.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Reloading on every filter keystroke would hammer the local service; the
    // debounced query is the only dependency that changes rapidly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.kind, filters.accountId, debouncedQuery]);

  const startEdit = (record: AgentMemoryRecord) => {
    setEditingId(record.id);
    setEditDraft(record.summary);
    setArmedDeleteId(null);
  };

  const saveEdit = async () => {
    if (!editingId || busy) return;
    const summary = editDraft.trim();
    if (!summary) return;
    setBusyId(editingId);
    setError(null);
    try {
      const result = await api.agentMemoryUpdate(editingId, summary);
      setItems((current) => current.map((record) => record.id === editingId ? { ...record, ...result.item } : record));
      setEditingId(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t("agentMemory.saveError"));
    } finally {
      setBusyId(null);
    }
  };

  const deleteRecord = async (recordId: string) => {
    if (busy) return;
    setBusyId(recordId);
    setError(null);
    try {
      await api.agentMemoryDelete(recordId);
      setLeavingIds((current) => new Set(current).add(recordId));
      window.setTimeout(() => {
        setItems((current) => current.filter((record) => record.id !== recordId));
        setLeavingIds((current) => {
          if (!current.has(recordId)) return current;
          const next = new Set(current);
          next.delete(recordId);
          return next;
        });
      }, 190);
      setArmedDeleteId(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t("agentMemory.deleteError"));
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    if (busy) return;
    setBusyId("__clear__");
    setError(null);
    try {
      await api.agentMemoryClear();
      setItems([]);
      setPendingClear(false);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t("agentMemory.clearError"));
    } finally {
      setBusyId(null);
    }
  };

  const updateQuery = (event: ChangeEvent<HTMLInputElement>) => {
    setFilters((current) => ({ ...current, query: event.target.value }));
  };

  const hasActiveFilters = filters.kind !== "" || filters.accountId !== "" || filters.query !== "";

  return (
    <>
      <div className={`modal-backdrop agent-memory-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pendingClear) requestClose();
      }}>
        <section ref={dialogRef} className={`modal-card agent-memory-modal${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="agent-memory-title" tabIndex={-1}>
          <header className="modal-heading agent-memory-heading">
            <div><span className="eyebrow">{t("agentMemory.eyebrow")}</span><h2 id="agent-memory-title">{t("agentMemory.title")}</h2></div>
            <div className="agent-memory-heading-actions">
              <span className="app-tooltip app-tooltip-icon">
                <button className="icon-button" type="button" aria-label={t("agentMemory.refreshTooltip")} onClick={() => void load(true)} disabled={loading}>
                  {loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
                </button>
                <span className="app-tooltip-content" role="tooltip">{t("agentMemory.refreshTooltip")}</span>
              </span>
              <span className="app-tooltip app-tooltip-icon">
                <button className="icon-button" type="button" aria-label={t("agentMemory.closeTooltip")} onClick={requestClose}><X size={18} /></button>
                <span className="app-tooltip-content" role="tooltip">{t("agentMemory.closeTooltip")}</span>
              </span>
            </div>
          </header>

          <div className="agent-memory-filters" role="search" aria-label={t("agentMemory.filtersLabel")}>
            <label className="agent-memory-filter-field">
              <Search size={14} />
              <input
                type="search"
                value={filters.query}
                placeholder={t("agentMemory.searchPlaceholder")}
                aria-label={t("agentMemory.searchPlaceholder")}
                disabled={loading || busy}
                onChange={updateQuery}
              />
            </label>
            <ThemedSelect
              id="agent-memory-kind-filter"
              value={filters.kind}
              aria-label={t("agentMemory.kindFilterLabel")}
              disabled={loading || busy}
              onValueChange={(value) => setFilters((current) => ({ ...current, kind: value as MemoryFilters["kind"] }))}
            >
              <option value="">{t("agentMemory.kindFilterAll")}</option>
              {memoryKinds.map((kind) => (
                <option key={kind} value={kind}>{memoryKindLabel(kind, t)}</option>
              ))}
            </ThemedSelect>
            <ThemedSelect
              id="agent-memory-account-filter"
              value={filters.accountId}
              aria-label={t("agentMemory.accountFilterLabel")}
              disabled={loading || busy}
              onValueChange={(value) => setFilters((current) => ({ ...current, accountId: value }))}
            >
              <option value="">{t("agentMemory.accountFilterAll")}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.email}</option>
              ))}
            </ThemedSelect>
          </div>

          {error && <div className="form-status error agent-memory-error" role="alert"><CircleAlert size={16} />{error}</div>}

          <div className="agent-memory-list" role="list" aria-label={t("agentMemory.listLabel")} aria-live="polite" aria-busy={loading}>
            {loading && items.length === 0 && (
              <div className="skeleton-stack" aria-hidden="true">
                <div className="skeleton-card" />
                <div className="skeleton-card" />
                <div className="skeleton-card" />
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="agent-memory-empty"><BookOpen size={26} /><h3>{hasActiveFilters ? t("agentMemory.emptyFilteredTitle") : t("agentMemory.emptyTitle")}</h3><p>{hasActiveFilters ? t("agentMemory.emptyFilteredDescription") : t("agentMemory.emptyDescription")}</p></div>
            )}
            {items.map((record, index) => (
              <AgentMemoryItemCard
                key={record.id}
                record={record}
                accountEmail={accountEmail(accounts, record.accountId)}
                editing={editingId === record.id}
                editDraft={editDraft}
                busy={busyId === record.id}
                armedDelete={armedDeleteId === record.id}
                leaving={leavingIds.has(record.id)}
                style={{ animationDelay: `${Math.min(index * 32, 130)}ms` }}
                onStartEdit={() => startEdit(record)}
                onEditDraftChange={setEditDraft}
                onSaveEdit={() => void saveEdit()}
                onCancelEdit={() => setEditingId(null)}
                onArmDelete={() => setArmedDeleteId(record.id)}
                onDisarmDelete={() => setArmedDeleteId(null)}
                onDelete={() => void deleteRecord(record.id)}
              />
            ))}
          </div>

          <footer className="agent-memory-footer">
            <button className="secondary-button danger-button" type="button" disabled={loading || busy || items.length === 0} onClick={() => { resetClearClosing(); setPendingClear(true); }}>
              <Trash2 size={14} />{t("agentMemory.clearAll")}
            </button>
          </footer>
        </section>
      </div>

      {pendingClear && (
        <div className={`modal-backdrop confirmation-backdrop${clearClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && requestClearClose()}>
          <section ref={clearConfirmationRef} className={`confirmation-card${clearClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="agent-memory-clear-title" aria-describedby="agent-memory-clear-description" tabIndex={-1}>
            <span className="eyebrow">{t("agentMemory.clearConfirmation.eyebrow")}</span>
            <h3 id="agent-memory-clear-title">{t("agentMemory.clearConfirmation.title", { count: items.length })}</h3>
            <p id="agent-memory-clear-description">{t("agentMemory.clearConfirmation.description")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={busy} onClick={requestClearClose}>{t("common.cancel")}</button>
              <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => void clearAll()}>
                {busyId === "__clear__" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("agentMemory.clearConfirmation.action")}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
