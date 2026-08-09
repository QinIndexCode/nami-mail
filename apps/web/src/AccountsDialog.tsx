import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, Pencil, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { api } from "./api";
import { accountHealthIssue, mailErrorMessage } from "./errorPresentation";
import { useI18n } from "./i18n";
import { providerDisplayName } from "./providerOnboarding";
import type { Account } from "./types";
import { ManagementDialogShell } from "./ManagementDialogs";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";

type Notice = { kind: "success" | "error"; message: string } | null;

/** Accounts past this count unlock the search / pagination / bulk toolbar. */
const ACCOUNTS_PER_PAGE = 5;

export type AccountsDialogProps = {
  accounts: Account[];
  demoMode?: boolean;
  onClose: () => void;
  /** Called after the account has been removed, or directly in demo mode. */
  onAccountRemoved: (accountId: string) => void | Promise<void>;
  /** Called after an account signature has been saved, or directly in demo mode. */
  onAccountSignatureChanged: (accountId: string, signature: string) => void | Promise<void>;
  /** Retries a single account and lets the host refresh its health state. */
  onAccountSync?: (accountId: string) => Promise<{ synced: number; folders: number; failedFolders: number }>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

export default function AccountsDialog({
  accounts,
  demoMode = false,
  onClose,
  onAccountRemoved,
  onAccountSignatureChanged,
  onAccountSync,
  fallbackFocusRef,
}: AccountsDialogProps) {
  const { locale, t } = useI18n();
  const [notice, setNotice] = useState<Notice>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingAccountRemoval, setPendingAccountRemoval] = useState<string | null>(null);
  const [pendingBulkRemoval, setPendingBulkRemoval] = useState(false);
  const [signatureDrafts, setSignatureDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(accounts.map((account) => [account.id, account.signature])),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const accountsDialog = useRef<HTMLElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const pendingRemovalAccount = accounts.find((account) => account.id === pendingAccountRemoval) ?? null;
  const controlsBusy = Boolean(busyAction);

  // The search / pagination / bulk toolbar only appears once there are more
  // accounts than one page can hold.
  const showToolbar = accounts.length > ACCOUNTS_PER_PAGE;

  const filteredAccounts = useMemo(() => {
    if (!showToolbar || !searchQuery.trim()) return accounts;
    const needle = searchQuery.trim().toLocaleLowerCase();
    return accounts.filter((account) => {
      const providerName = providerDisplayName({ id: account.provider, name: account.providerName }, locale, t);
      return (
        account.email.toLocaleLowerCase().includes(needle)
        || account.providerName.toLocaleLowerCase().includes(needle)
        || providerName.toLocaleLowerCase().includes(needle)
      );
    });
  }, [accounts, searchQuery, showToolbar, locale, t]);

  const pageCount = Math.max(1, Math.ceil(filteredAccounts.length / ACCOUNTS_PER_PAGE));
  const clampedPage = Math.min(page, pageCount);
  const pageAccounts = useMemo(() => {
    if (!showToolbar) return filteredAccounts;
    const start = (clampedPage - 1) * ACCOUNTS_PER_PAGE;
    return filteredAccounts.slice(start, start + ACCOUNTS_PER_PAGE);
  }, [filteredAccounts, showToolbar, clampedPage]);

  // Keep the page and selection valid after accounts change (e.g. removal).
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    const valid = new Set(accounts.map((account) => account.id));
    setSelectedIds((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const id of next) {
        if (!valid.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [accounts]);

  const dismissRemoval = () => {
    if (controlsBusy) return;
    setPendingAccountRemoval(null);
    setPendingBulkRemoval(false);
  };

  const { closing, requestClose } = useDismissTransition(() => {
    onClose();
  });
  const { closing: confirmClosing, requestClose: requestConfirmClose, reset: resetConfirmClosing } = useDismissTransition(dismissRemoval);

  // Capture-phase so Escape first dismisses the nested removal confirmation,
  // and `stopImmediatePropagation` keeps the host keydown handler from also
  // closing the dialog underneath it.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pendingAccountRemoval || pendingBulkRemoval) {
        requestConfirmClose();
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  });

  useDialogFocus(true, accountsDialog, { fallbackFocusRef });
  useDialogFocus(Boolean(pendingAccountRemoval || pendingBulkRemoval), confirmationDialog, { fallbackFocusRef: accountsDialog });

  const removeAccount = async (accountId: string) => {
    if (busyAction) return;
    setBusyAction(`account-remove-${accountId}`);
    setNotice(null);
    try {
      if (!demoMode) await api.removeAccount(accountId);
      await onAccountRemoved(accountId);
      setPendingAccountRemoval(null);
      setNotice({
        kind: "success",
        message: demoMode ? t("settings.account.removedFromDemo") : t("settings.account.removed"),
      });
    } catch (error) {
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.error.removeAccount"), t) });
      setPendingAccountRemoval(null);
    } finally {
      setBusyAction(null);
    }
  };

  const retryAccount = async (account: Account) => {
    if (busyAction) return;
    setBusyAction(`account-sync-${account.id}`);
    setNotice(null);
    try {
      const result = onAccountSync
        ? await onAccountSync(account.id)
        : demoMode
          ? { synced: 0, folders: 0, failedFolders: 0 }
          : await api.sync(account.id);
      const summary = result.failedFolders
        ? t("settings.account.syncPartial", { email: account.email, failedFolders: result.failedFolders })
        : result.synced
          ? t("settings.account.syncCompletedWithMessages", { email: account.email, synced: result.synced })
          : t("settings.account.syncCompleted", { email: account.email });
      setNotice({ kind: result.failedFolders ? "error" : "success", message: summary });
    } catch (error) {
      setNotice({ kind: "error", message: t("settings.account.syncFailed", { email: account.email, message: mailErrorMessage(error, undefined, t) }) });
    } finally {
      setBusyAction(null);
    }
  };

  const saveAccountSignature = async (account: Account) => {
    if (busyAction) return;
    const signature = (signatureDrafts[account.id] ?? "").trim();
    setBusyAction(`account-signature-${account.id}`);
    setNotice(null);
    try {
      if (!demoMode) await api.updateAccountSignature(account.id, signature);
      await onAccountSignatureChanged(account.id, signature);
      setSignatureDrafts((drafts) => ({ ...drafts, [account.id]: signature }));
      setEditingId(null);
      setNotice({ kind: "success", message: t("settings.account.signatureSaved", { email: account.email }) });
    } catch (error) {
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.error.saveSignature"), t) });
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSelect = (accountId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const allPageSelected = showToolbar && pageAccounts.length > 0 && pageAccounts.every((account) => selectedIds.has(account.id));

  const toggleAllPage = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allPageSelected) {
        for (const account of pageAccounts) next.delete(account.id);
      } else {
        for (const account of pageAccounts) next.add(account.id);
      }
      return next;
    });
  };

  const resyncSelected = async () => {
    if (busyAction) return;
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusyAction("accounts-bulk-sync");
    setNotice(null);
    let synced = 0;
    let failed = 0;
    let failedFolders = 0;
    for (const accountId of ids) {
      try {
        const result = onAccountSync
          ? await onAccountSync(accountId)
          : demoMode
            ? { synced: 0, folders: 0, failedFolders: 0 }
            : await api.sync(accountId);
        synced += 1;
        failedFolders += result.failedFolders;
      } catch {
        failed += 1;
      }
    }
    if (failed || failedFolders) {
      setNotice({ kind: "error", message: t("settings.account.bulkResyncPartial", { synced, failed }) });
    } else {
      setNotice({ kind: "success", message: t("settings.account.bulkResyncCompleted", { count: synced }) });
    }
    setBusyAction(null);
  };

  const removeSelected = async () => {
    if (busyAction) return;
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusyAction("accounts-bulk-remove");
    setNotice(null);
    let removed = 0;
    let failed = 0;
    for (const accountId of ids) {
      try {
        if (!demoMode) await api.removeAccount(accountId);
        await onAccountRemoved(accountId);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    setPendingBulkRemoval(false);
    setSelectedIds(new Set());
    if (failed) {
      setNotice({ kind: "error", message: t("settings.account.bulkRemovedPartial", { removed, failed }) });
    } else {
      setNotice({ kind: "success", message: demoMode ? t("settings.account.removedFromDemo") : t("settings.account.bulkRemoved", { count: removed }) });
    }
    setBusyAction(null);
  };

  return (
    <>
      <ManagementDialogShell
        titleId="accounts-dialog-title"
        eyebrow={t("navigation.management")}
        title={t("settings.account.title")}
        description={demoMode ? t("settings.account.demoDescription") : t("settings.account.description")}
        onClose={requestClose}
        fallbackFocusRef={fallbackFocusRef}
        dialogRef={accountsDialog}
      >
        <section className="settings-section settings-accounts">
          {notice && (
            <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
              {notice.kind === "success" ? <Check size={17} /> : <X size={17} />}
              {notice.message}
            </div>
          )}
          {accounts.length === 0 ? (
            <p className="settings-empty">{t("settings.account.empty")}</p>
          ) : (
            <>
              {showToolbar && (
                <div className="accounts-toolbar">
                  <div className="search-wrap accounts-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        setPage(1);
                      }}
                      placeholder={t("settings.account.searchPlaceholder")}
                      aria-label={t("settings.account.searchAriaLabel")}
                    />
                    {searchQuery && (
                      <button className="icon-button search-clear" type="button" aria-label={t("settings.account.clearSearch")} onClick={() => setSearchQuery("")}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {selectedIds.size > 0 ? (
                    <div className="accounts-bulk-actions">
                      <span className="accounts-bulk-count">{t("settings.account.selectedCount", { count: selectedIds.size })}</span>
                      <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void resyncSelected()}>
                        {busyAction === "accounts-bulk-sync" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t("settings.account.bulkResync")}
                      </button>
                      <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingBulkRemoval(true); }}>
                        {busyAction === "accounts-bulk-remove" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{t("settings.account.bulkRemove")}
                      </button>
                      <button className="secondary-button accounts-bulk-clear" type="button" disabled={controlsBusy} onClick={() => setSelectedIds(new Set())}>
                        {t("settings.account.clearSelection")}
                      </button>
                    </div>
                  ) : (
                    <label className="accounts-select-all">
                      <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} aria-label={t("settings.account.selectAllAriaLabel")} />
                      {t("settings.account.selectAll")}
                    </label>
                  )}
                </div>
              )}
              {filteredAccounts.length === 0 ? (
                <p className="settings-empty">{t("settings.account.noSearchResults")}</p>
              ) : (
                <>
                  <div className="accounts-table-list">
                    {pageAccounts.map((account) => {
                      const issue = accountHealthIssue(account, t);
                      const retrying = busyAction === `account-sync-${account.id}`;
                      const saving = busyAction === `account-signature-${account.id}`;
                      const editing = editingId === account.id;
                      const selected = selectedIds.has(account.id);
                      const providerName = providerDisplayName({ id: account.provider, name: account.providerName }, locale, t);
                      return (
                        <div className={`accounts-row${selected ? " selected" : ""}${editing ? " editing" : ""}${issue ? " has-issue" : ""}`} key={account.id}>
                          <div className="accounts-row-main">
                            {showToolbar && (
                              <label className="accounts-row-check">
                                <input type="checkbox" checked={selected} onChange={() => toggleSelect(account.id)} aria-label={t("settings.account.selectAriaLabel", { email: account.email })} />
                              </label>
                            )}
                            <span className={`status-dot ${issue ? "error" : account.status}`} aria-hidden="true" />
                            <div className="accounts-row-copy">
                              <strong>{account.email}</strong>
                              <small className={issue ? "account-error" : ""}>{issue ? `${providerName} · ${issue.title}` : providerName}</small>
                              {issue && <small className="account-error-guidance">{issue.guidance}</small>}
                            </div>
                            <div className="accounts-row-actions">
                              {issue?.retryable && (
                                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void retryAccount(account)}>
                                  {retrying ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t("settings.account.resync")}
                                </button>
                              )}
                              <button className="secondary-button" type="button" aria-label={t("settings.account.editAriaLabel", { email: account.email })} disabled={controlsBusy} onClick={() => setEditingId(editing ? null : account.id)}>
                                <Pencil size={15} />{t("settings.account.edit")}
                              </button>
                              <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.account.removeAriaLabel", { email: account.email })} data-tooltip={t("settings.account.removeTooltip")} disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingAccountRemoval(account.id); }}>
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                          {editing && (
                            <div className="accounts-row-edit">
                              <label htmlFor={`account-signature-${account.id}`}>{t("settings.account.signatureLabel")}</label>
                              <textarea id={`account-signature-${account.id}`} rows={3} maxLength={2000} value={signatureDrafts[account.id] ?? ""} onChange={(event) => setSignatureDrafts((drafts) => ({ ...drafts, [account.id]: event.target.value }))} placeholder={t("settings.account.signaturePlaceholder")} />
                              <div className="settings-account-signature-actions">
                                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => { setEditingId(null); setSignatureDrafts((drafts) => ({ ...drafts, [account.id]: account.signature })); }}>
                                  {t("settings.account.cancelEdit")}
                                </button>
                                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void saveAccountSignature(account)}>
                                  {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{t("settings.account.saveSignature")}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {showToolbar && pageCount > 1 && (
                    <div className="accounts-pager">
                      <button className="secondary-button" type="button" disabled={controlsBusy || clampedPage <= 1} onClick={() => setPage(clampedPage - 1)} aria-label={t("settings.account.pagerPrevious")}>
                        <ChevronLeft size={15} />{t("settings.account.pagerPrevious")}
                      </button>
                      <span className="accounts-pager-status" role="status">{t("settings.account.pagerLabel", { page: clampedPage, total: pageCount })}</span>
                      <button className="secondary-button" type="button" disabled={controlsBusy || clampedPage >= pageCount} onClick={() => setPage(clampedPage + 1)} aria-label={t("settings.account.pagerNext")}>
                        {t("settings.account.pagerNext")}<ChevronRight size={15} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </ManagementDialogShell>
      {(pendingRemovalAccount || pendingBulkRemoval) && (
        <div className={`modal-backdrop confirmation-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestConfirmClose()}>
          <section ref={confirmationDialog} className={`confirmation-card${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="accounts-confirmation-title" aria-describedby="accounts-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            {pendingRemovalAccount ? (
              <>
                <h3 id="accounts-confirmation-title">{t("settings.confirmation.removeAccountTitle", { email: pendingRemovalAccount.email })}</h3>
                <p id="accounts-confirmation-description">{t("settings.confirmation.removeAccountDescription")}</p>
                <div className="confirmation-actions">
                  <button className="secondary-button" type="button" data-dialog-initial-focus disabled={controlsBusy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
                  <button
                    className="secondary-button danger-button"
                    type="button"
                    disabled={controlsBusy}
                    onClick={() => void removeAccount(pendingRemovalAccount.id)}
                  >
                    {busyAction === `account-remove-${pendingRemovalAccount.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.confirmation.removeAccountAction")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="accounts-confirmation-title">{t("settings.account.bulkRemoveTitle", { count: selectedIds.size })}</h3>
                <p id="accounts-confirmation-description">{t("settings.account.bulkRemoveDescription")}</p>
                <div className="confirmation-actions">
                  <button className="secondary-button" type="button" data-dialog-initial-focus disabled={controlsBusy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
                  <button
                    className="secondary-button danger-button"
                    type="button"
                    disabled={controlsBusy}
                    onClick={() => void removeSelected()}
                  >
                    {busyAction === "accounts-bulk-remove" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.account.bulkRemoveAction")}
                  </button>
                </div>              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
