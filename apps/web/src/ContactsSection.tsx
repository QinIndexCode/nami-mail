import { BookUser, Check, ChevronLeft, ChevronRight, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, UserRound, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { mailErrorMessage } from "./errorPresentation";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useDismissTransition } from "./hooks/useDismissTransition";
import { contactsCache } from "./dialogPrefetch";
import { useStablePagedListHeight } from "./hooks/useStablePagedListHeight";
import type { Contact, ContactInput } from "./types";
import { getAvatar, setAvatar } from "./avatarStore";
import { AvatarEditor } from "./AvatarEditor";

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
  /** Source marker of the row being edited (create drafts are manual). */
  autoCollected: boolean;
  /** Locally stored avatar for the contact's email (never sent to the service). */
  avatarDataUrl: string | null;
  /** Email the row had when editing started; stale avatar keys are cleared on rename. */
  originalEmail?: string;
};

type Notice = { kind: "success" | "error"; message: string } | null;

/** Contacts past this count unlock the search / pagination / bulk toolbar. */
const CONTACTS_PER_PAGE = 5;

type SourceFilter = "all" | "manual" | "auto";

/**
 * Narrow the contact list to one source. Kept as a pure function so the
 * filtering behavior is unit-testable without DOM interaction.
 */
export function applySourceFilter(contacts: Contact[], sourceFilter: SourceFilter): Contact[] {
  if (sourceFilter === "all") return contacts;
  return contacts.filter((contact) => sourceFilter === "auto" ? contact.autoCollected : !contact.autoCollected);
}

/**
 * The "all" view renders manual rows first and auto-added rows after, keeping
 * each group's original ordering. Pure so the grouping is unit-testable.
 */
export function orderContactsBySource(contacts: Contact[]): Contact[] {
  return [
    ...contacts.filter((contact) => !contact.autoCollected),
    ...contacts.filter((contact) => contact.autoCollected),
  ];
}

function emptyDraft(): ContactDraft {
  return { email: "", name: "", notes: "", autoCollected: false, avatarDataUrl: null };
}

export default function ContactsSection({ demoMode = false, initialContacts }: ContactsSectionProps) {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[]>(initialContacts ?? []);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!demoMode && initialContacts === undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyContactId, setBusyContactId] = useState<string | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [page, setPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const editorPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (demoMode || initialContacts !== undefined) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    void contactsCache.get().then((items) => {
      if (!active) return;
      setContacts(items);
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

  // Search narrows the full list; the source filter is applied afterwards, and
  // its tab counts track the search so the numbers stay meaningful while typing.
  const queryFiltered = useMemo(() => {
    if (!showToolbar || !query.trim()) return contacts;
    const needle = query.trim().toLocaleLowerCase();
    return contacts.filter((contact) =>
      contact.email.toLocaleLowerCase().includes(needle) || contact.name.toLocaleLowerCase().includes(needle));
  }, [contacts, query, showToolbar]);

  const sourceCounts = useMemo(() => {
    const manual = queryFiltered.filter((contact) => !contact.autoCollected).length;
    return { all: queryFiltered.length, manual, auto: queryFiltered.length - manual };
  }, [queryFiltered]);

  const filteredContacts = useMemo(() => applySourceFilter(queryFiltered, sourceFilter), [queryFiltered, sourceFilter]);

  // The "all" view renders as two sections (manual first, then auto-added);
  // grouping only kicks in when both source groups are present.
  const orderedAll = useMemo(() => sourceFilter === "all" ? orderContactsBySource(filteredContacts) : filteredContacts, [filteredContacts, sourceFilter]);
  const showSourceGroups = sourceFilter === "all" && sourceCounts.manual > 0 && sourceCounts.auto > 0;

  const pageCount = Math.max(1, Math.ceil(orderedAll.length / CONTACTS_PER_PAGE));
  const clampedPage = Math.min(page, pageCount);
  const pageContacts = useMemo(() => {
    if (!showToolbar) return orderedAll;
    const start = (clampedPage - 1) * CONTACTS_PER_PAGE;
    return orderedAll.slice(start, start + CONTACTS_PER_PAGE);
  }, [orderedAll, showToolbar, clampedPage]);

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

  // Contact editor — a floating dialog layered above the list; `draft` being
  // set means the editor is open (create or edit).
  useDialogFocus(Boolean(draft), editorPanel);
  const { closing: editorClosing, requestClose: requestEditorClose, reset: resetEditorClosing } = useDismissTransition(() => setDraft(null));
  const closeEditor = () => {
    if (!busy) requestEditorClose();
  };

  // Escape first dismisses the editor (capture + stopImmediatePropagation so
  // the host dialog beneath it stays open).
  useEffect(() => {
    if (!draft) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeEditor();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  });

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
    contactsCache.refresh();
    setPendingBulkDelete(false);
    setSelectedIds(new Set());
    if (failed) {
      setNotice({ kind: "error", message: t("settings.contacts.bulkDeletedPartial", { removed, failed }) });
    } else {
      setNotice({ kind: "success", message: t("settings.contacts.bulkDeleted", { count: removed }) });
    }
    setBusy(false);
  };

  const listScroll = useStablePagedListHeight<HTMLDivElement>(showToolbar);

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
      contactsCache.refresh();
      setAvatar(email, draft.avatarDataUrl);
      if (draft.originalEmail && draft.originalEmail.toLowerCase() !== email) {
        setAvatar(draft.originalEmail, null);
      }
      setDraft(null);
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
      contactsCache.refresh();
      setArmedDeleteId(null);
      setNotice({ kind: "success", message: t("settings.contacts.deleted") });
    } catch (error) {
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.contacts.deleteFailed"), t) });
    } finally {
      setBusyContactId(null);
    }
  };

  const startEdit = (contact: Contact) => {
    resetEditorClosing();
    setArmedDeleteId(null);
    setDraft({ id: contact.id, email: contact.email, name: contact.name, notes: contact.notes, autoCollected: contact.autoCollected, avatarDataUrl: getAvatar(contact.email), originalEmail: contact.email });
  };

  const pageStart = showToolbar ? (clampedPage - 1) * CONTACTS_PER_PAGE : 0;

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
          <div className="content-enter">
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

            {showToolbar && (
              <div className="contacts-source-filter" role="group" aria-label={t("settings.contacts.sourceFilterLabel")}>
                {([
                  ["all", t("settings.contacts.filterAll"), sourceCounts.all],
                  ["manual", t("settings.contacts.filterManual"), sourceCounts.manual],
                  ["auto", t("settings.contacts.filterAuto"), sourceCounts.auto],
                ] as const).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    className="source-filter-button"
                    aria-pressed={sourceFilter === value}
                    disabled={controlsBusy}
                    onClick={() => {
                      setSourceFilter(value);
                      setPage(1);
                    }}
                  >
                    {label}<span className="source-filter-count">{count}</span>
                  </button>
                ))}
              </div>
            )}

            {filteredContacts.length === 0 ? (
              <p className="settings-empty">{showToolbar ? t("settings.contacts.noSearchResults") : (contacts.length === 0 ? t("settings.contacts.empty") : t("settings.contacts.noMatches"))}</p>
            ) : (
              <>
                <div ref={listScroll.ref} className="contacts-list" style={listScroll.style}>
                  {pageContacts.map((contact, index) => {
                    const deleting = busyContactId === contact.id;
                    const selected = selectedIds.has(contact.id);
                    const globalIndex = pageStart + index;
                    const groupStart = showSourceGroups && (globalIndex === 0 || Boolean(orderedAll[globalIndex - 1]?.autoCollected) !== contact.autoCollected);
                    return (
                      <Fragment key={contact.id}>
                        {groupStart && (
                          <div className="contact-group-head" role="heading" aria-level={3}>
                            {contact.autoCollected ? t("settings.contacts.filterAuto") : t("settings.contacts.filterManual")}
                            <span className="contact-group-count">({contact.autoCollected ? sourceCounts.auto : sourceCounts.manual})</span>
                          </div>
                        )}
                      <div className={`contact-row${selected ? " selected" : ""}`}>
                        {showToolbar && (
                          <label className="contacts-row-check">
                            <input type="checkbox" checked={selected} onChange={() => toggleSelect(contact.id)} aria-label={t("settings.contacts.selectAriaLabel", { email: contact.email })} />
                          </label>
                        )}
                        <div className="contact-head">
                            <span className="contact-avatar" aria-hidden="true"><UserRound size={16} /></span>
                            <div className="contact-copy">
                              <strong>{contact.name || contact.email}</strong>
                              {contact.name && <small>{contact.email}</small>}
                              {contact.notes && <small className="contact-notes">{contact.notes}</small>}
                              {contact.autoCollected
                                ? <small className="contact-auto-badge">{t("settings.contacts.autoCollected")}</small>
                                : <small className="contact-manual-badge">{t("settings.contacts.manualAdded")}</small>}
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
                      </div>
                      </Fragment>
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

            <div className="settings-inline-actions">
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => {
                  resetEditorClosing();
                  setArmedDeleteId(null);
                  setDraft(emptyDraft());
                }}>
                  <Plus size={15} />{t("settings.contacts.addContact")}
                </button>
              </div>
          </div>
        )}
      </section>
      {draft && (
        <div className={`modal-backdrop contact-editor-backdrop${editorClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}>
          <section ref={editorPanel} className={`contact-editor-modal${editorClosing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={draft.id ? t("settings.contacts.edit") : t("settings.contacts.addContact")} aria-labelledby="contact-editor-title" tabIndex={-1}>
            <div className="contact-editor" role="form" aria-label={draft.id ? t("settings.contacts.edit") : t("settings.contacts.addContact")}>
              <div className="contact-editor-head">
                <AvatarEditor name={draft.name} address={draft.email} current={draft.avatarDataUrl} disabled={busy} onChange={(dataUrl) => setDraft({ ...draft, avatarDataUrl: dataUrl })} />
                <div>
                  <span className="eyebrow">{draft.id ? t("settings.contacts.edit") : t("settings.contacts.addContact")}</span>
                  <h3 id="contact-editor-title" className="contact-editor-title">{draft.name.trim() || draft.email || t("settings.contacts.title")}</h3>
                </div>
              </div>
              {draft.id && draft.autoCollected && (
                <div className="contact-editor-source">
                  <small className="contact-auto-badge">{t("settings.contacts.autoCollected")}</small>
                  <span>{t("settings.contacts.editPromotesManual")}</span>
                </div>
              )}
              <label className="calendar-field" htmlFor="contact-email-input">
                <span>{t("settings.contacts.emailLabel")}</span>
                <input id="contact-email-input" type="text" value={draft.email} autoComplete="off" spellCheck={false} disabled={busy} autoFocus onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
              </label>
              <label className="calendar-field" htmlFor="contact-name-input">
                <span>{t("settings.contacts.nameLabel")}</span>
                <input id="contact-name-input" type="text" value={draft.name} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label className="calendar-field" htmlFor="contact-notes-input">
                <span>{t("settings.contacts.notesLabel")}</span>
                <textarea id="contact-notes-input" value={draft.notes} rows={3} disabled={busy} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </label>
              <div className="contact-editor-actions">
                <button className="secondary-button" type="button" disabled={busy} onClick={closeEditor}>{t("common.cancel")}</button>
                <button className="primary-button" type="button" disabled={busy} onClick={() => void saveDraft()}>
                  {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("settings.contacts.save")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
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
