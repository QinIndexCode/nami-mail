import { BookUser, Check, ChevronLeft, ChevronRight, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { mailErrorMessage } from "./errorPresentation";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";
import type { Contact, ContactInput } from "./types";

export type ContactsSectionProps = {
  demoMode?: boolean;
  /** Test seam: preloaded contacts skip the API load. */
  initialContacts?: Contact[];
};

type ContactDraft = {
  id?: string;
  email: string;
  name: string;
  notes: string;
};

type Notice = { kind: "success" | "error"; message: string } | null;

/** Contacts past this count unlock the search / pagination / bulk toolbar. */
const CONTACTS_PER_PAGE = 5;

function emptyDraft(): ContactDraft {
  return { email: "", name: "", notes: "" };
}

export default function ContactsSection({ demoMode = false, initialContacts }: ContactsSectionProps) {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[]>(initialContacts ?? []);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!demoMode && initialContacts === undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyContactId, setBusyContactId] = useState<string | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const confirmationDialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (demoMode || initialContacts !== undefined) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    void api.contacts().then((result) => {
      if (!active) return;
      setContacts(result.items);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [demoMode, initialContacts, loadAttempt]);

  const showToolbar = contacts.length > CONTACTS_PER_PAGE;

  const filteredContacts = useMemo(() => {
    if (!showToolbar || !query.trim()) return contacts;
    const needle = query.trim().toLocaleLowerCase();
    return contacts.filter((contact) =>
      contact.email.toLocaleLowerCase().includes(needle) || contact.name.toLocaleLowerCase().includes(needle));
  }, [contacts, query, showToolbar]);

  const pageCount = Math.max(1, Math.ceil(filteredContacts.length / CONTACTS_PER_PAGE));
  const clampedPage = Math.min(page, pageCount);
  const pageContacts = useMemo(() => {
    if (!showToolbar) return filteredContacts;
    const start = (clampedPage - 1) * CONTACTS_PER_PAGE;
    return filteredContacts.slice(start, start + CONTACTS_PER_PAGE);
  }, [filteredContacts, showToolbar, clampedPage]);

  // Keep the page and selection valid after contacts change (e.g. removal).
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    const valid = new Set(contacts.map((contact) => contact.id));
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
  }, [contacts]);

  useDialogFocus(pendingBulkDelete, confirmationDialog);
  const { closing: confirmClosing, requestClose: requestConfirmClose, reset: resetConfirmClosing } = useDismissTransition(() => setPendingBulkDelete(false));

  const controlsBusy = busy || Boolean(busyContactId);

  const toggleSelect = (contactId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  const allPageSelected = showToolbar && pageContacts.length > 0 && pageContacts.every((contact) => selectedIds.has(contact.id));

  const toggleAllPage = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allPageSelected) {
        for (const contact of pageContacts) next.delete(contact.id);
      } else {
        for (const contact of pageContacts) next.add(contact.id);
      }
      return next;
    });
  };

  const removeSelected = async () => {
    if (busy) return;
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusy(true);
    setNotice(null);
    let removed = 0;
    let failed = 0;
    for (const contactId of ids) {
      try {
        if (!demoMode) await api.deleteContact(contactId);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    setContacts((current) => current.filter((contact) => !ids.includes(contact.id)));
    setPendingBulkDelete(false);
    setSelectedIds(new Set());
    if (failed) {
      setNotice({ kind: "error", message: t("settings.contacts.bulkDeletedPartial", { removed, failed }) });
    } else {
      setNotice({ kind: "success", message: t("settings.contacts.bulkDeleted", { count: removed }) });
    }
    setBusy(false);
  };

  if (demoMode) {
    return (
      <section className="settings-section" aria-labelledby="contacts-settings">
        <div className="settings-section-title">
          <BookUser size={16} />
          <div><span>{t("settings.contacts.title")}</span><p id="contacts-settings">{t("settings.contacts.description")}</p></div>
        </div>
        <p className="settings-empty" role="status">{t("settings.contacts.demoUnavailable")}</p>
      </section>
    );
  }

  const replaceContact = (updated: Contact) => {
    setContacts((current) => current.map((contact) => contact.id === updated.id ? updated : contact));
  };

  const saveDraft = async () => {
    if (!draft || busy) return;
    const email = draft.email.trim().toLowerCase();
    if (!email) {
      setNotice({ kind: "error", message: t("settings.contacts.validation.emailRequired") });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setNotice({ kind: "error", message: t("settings.contacts.validation.emailInvalid") });
      return;
    }
    const input: ContactInput = {
      email,
      ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    };
    setBusy(true);
    setNotice(null);
    try {
      if (draft.id) {
        const result = await api.updateContact(draft.id, input);
        replaceContact(result.contact);
        setNotice({ kind: "success", message: t("settings.contacts.updated") });
      } else {
        const result = await api.createContact(input);
        setContacts((current) => [...current, result.contact]);
        setNotice({ kind: "success", message: t("settings.contacts.saved") });
      }
      setDraft(null);
      setEditingId(null);
    } catch (error) {
      setNotice({
        kind: "error",
        message: mailErrorMessage(error, t(draft.id ? "settings.contacts.updateFailed" : "settings.contacts.saveFailed"), t),
      });
    } finally {
      setBusy(false);
    }
  };

  const deleteContact = async (contactId: string) => {
    if (busyContactId) return;
    setBusyContactId(contactId);
    setNotice(null);
    try {
      await api.deleteContact(contactId);
      setContacts((current) => current.filter((contact) => contact.id !== contactId));
      setArmedDeleteId(null);
      setNotice({ kind: "success", message: t("settings.contacts.deleted") });
    } catch (error) {
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.contacts.deleteFailed"), t) });
    } finally {
      setBusyContactId(null);
    }
  };

  const startEdit = (contact: Contact) => {
    setArmedDeleteId(null);
    setEditingId(contact.id);
    setDraft({ id: contact.id, email: contact.email, name: contact.name, notes: contact.notes });
  };

  const cancelEdit = () => {
    setDraft(null);
    setEditingId(null);
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="contacts-settings">
        <div className="settings-section-title">
          <BookUser size={16} />
          <div><span>{t("settings.contacts.title")}</span><p id="contacts-settings">{t("settings.contacts.description")}</p></div>
        </div>

        {notice && <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}{notice.message}</div>}

        {loading ? (
          <p className="settings-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("common.loading")}</p>
        ) : loadError ? (
          <div className="settings-empty translation-configuration-load-error" role="alert">
            <span>{mailErrorMessage(loadError, t("settings.contacts.loadFailed"), t)}</span>
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              <RefreshCw size={15} aria-hidden="true" />{t("common.retry")}
            </button>
          </div>
        ) : (
          <>
            {showToolbar && (
              <div className="contacts-toolbar">
                <label className="search-wrap contacts-search" htmlFor="contacts-search-input">
                  <Search size={14} aria-hidden="true" />
                  <input
                    id="contacts-search-input"
                    type="search"
                    value={query}
                    placeholder={t("settings.contacts.searchPlaceholder")}
                    aria-label={t("settings.contacts.searchAriaLabel")}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                  />
                  {query && (
                    <button className="icon-button search-clear" type="button" aria-label={t("settings.contacts.clearSearch")} onClick={() => setQuery("")}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                {selectedIds.size > 0 ? (
                  <div className="contacts-bulk-actions">
                    <span className="contacts-bulk-count">{t("settings.contacts.selectedCount", { count: selectedIds.size })}</span>
                    <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => { resetConfirmClosing(); setPendingBulkDelete(true); }}>
                      {busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{t("settings.contacts.bulkDelete")}
                    </button>
                    <button className="secondary-button contacts-bulk-clear" type="button" disabled={controlsBusy} onClick={() => setSelectedIds(new Set())}>
                      {t("settings.contacts.clearSelection")}
                    </button>
                  </div>
                ) : (
                  <label className="contacts-select-all">
                    <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} aria-label={t("settings.contacts.selectAllAriaLabel")} />
                    {t("settings.contacts.selectAll")}
                  </label>
                )}
              </div>
            )}

            {filteredContacts.length === 0 ? (
              <p className="settings-empty">{showToolbar ? t("settings.contacts.noSearchResults") : (contacts.length === 0 ? t("settings.contacts.empty") : t("settings.contacts.noMatches"))}</p>
            ) : (
              <>
                <div className="contacts-list">
                  {pageContacts.map((contact) => {
                    const deleting = busyContactId === contact.id;
                    const editing = editingId === contact.id;
                    const selected = selectedIds.has(contact.id);
                    return (
                      <div className={`contact-row${selected ? " selected" : ""}${editing ? " editing" : ""}`} key={contact.id}>
                        {showToolbar && !editing && (
                          <label className="contacts-row-check">
                            <input type="checkbox" checked={selected} onChange={() => toggleSelect(contact.id)} aria-label={t("settings.contacts.selectAriaLabel", { email: contact.email })} />
                          </label>
                        )}
                        {editing && draft ? (
                          <div className="contact-editor">
                            <label className="translation-setting-field" htmlFor={`contact-email-${contact.id}`}>
                              <span><strong>{t("settings.contacts.emailLabel")}</strong></span>
                              <input id={`contact-email-${contact.id}`} type="text" value={draft.email} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
                            </label>
                            <label className="translation-setting-field" htmlFor={`contact-name-${contact.id}`}>
                              <span><strong>{t("settings.contacts.nameLabel")}</strong></span>
                              <input id={`contact-name-${contact.id}`} type="text" value={draft.name} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                            </label>
                            <label className="translation-setting-field" htmlFor={`contact-notes-${contact.id}`}>
                              <span><strong>{t("settings.contacts.notesLabel")}</strong></span>
                              <textarea id={`contact-notes-${contact.id}`} value={draft.notes} rows={2} disabled={busy} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
                            </label>
                            <div className="settings-inline-actions contact-editor-actions">
                              <button className="primary-button" type="button" disabled={busy} onClick={() => void saveDraft()}>
                                {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t("settings.contacts.save")}
                              </button>
                              <button className="secondary-button" type="button" disabled={busy} onClick={cancelEdit}>
                                {t("common.cancel")}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="contact-head">
                            <span className="contact-avatar" aria-hidden="true"><UserRound size={16} /></span>
                            <div className="contact-copy">
                              <strong>{contact.name || contact.email}</strong>
                              {contact.name && <small>{contact.email}</small>}
                              {contact.notes && <small className="contact-notes">{contact.notes}</small>}
                              {contact.autoCollected && <small className="contact-auto-badge">{t("settings.contacts.autoCollected")}</small>}
                            </div>
                            <div className="contact-actions">
                              <button className="icon-button" type="button" aria-label={t("settings.contacts.edit")} data-tooltip={t("settings.contacts.edit")} disabled={Boolean(busyContactId)} onClick={() => startEdit(contact)}>
                                <Pencil size={15} />
                              </button>
                              {armedDeleteId === contact.id ? (
                                <>
                                  <button className="secondary-button danger-button" type="button" disabled={Boolean(busyContactId)} onClick={() => void deleteContact(contact.id)}>
                                    {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.contacts.confirmDelete")}
                                  </button>
                                  <button className="secondary-button" type="button" disabled={Boolean(busyContactId)} onClick={() => setArmedDeleteId(null)}>
                                    {t("common.cancel")}
                                  </button>
                                </>
                              ) : (
                                <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.contacts.delete")} data-tooltip={t("settings.contacts.delete")} disabled={Boolean(busyContactId)} onClick={() => setArmedDeleteId(contact.id)}>
                                  <Trash2 size={15} />
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {showToolbar && pageCount > 1 && (
                  <div className="contacts-pager">
                    <button className="secondary-button" type="button" disabled={controlsBusy || clampedPage <= 1} onClick={() => setPage(clampedPage - 1)} aria-label={t("settings.contacts.pagerPrevious")}>
                      <ChevronLeft size={15} />{t("settings.contacts.pagerPrevious")}
                    </button>
                    <span className="contacts-pager-status" role="status">{t("settings.contacts.pagerLabel", { page: clampedPage, total: pageCount })}</span>
                    <button className="secondary-button" type="button" disabled={controlsBusy || clampedPage >= pageCount} onClick={() => setPage(clampedPage + 1)} aria-label={t("settings.contacts.pagerNext")}>
                      {t("settings.contacts.pagerNext")}<ChevronRight size={15} />
                    </button>
                  </div>
                )}
              </>
            )}

            {!draft && (
              <div className="settings-inline-actions">
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => {
                  setArmedDeleteId(null);
                  setEditingId(null);
                  setDraft(emptyDraft());
                }}>
                  <Plus size={15} />{t("settings.contacts.addContact")}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {pendingBulkDelete && (
        <div className={`modal-backdrop confirmation-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && requestConfirmClose()}>
          <section ref={confirmationDialog} className={`confirmation-card${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="contacts-bulk-confirmation-title" aria-describedby="contacts-bulk-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            <h3 id="contacts-bulk-confirmation-title">{t("settings.contacts.bulkDeleteTitle", { count: selectedIds.size })}</h3>
            <p id="contacts-bulk-confirmation-description">{t("settings.contacts.bulkDeleteDescription")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={busy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
              <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => void removeSelected()}>
                {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.contacts.bulkDeleteAction")}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
