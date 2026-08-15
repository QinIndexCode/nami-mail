import { Check, ChevronLeft, ChevronRight, FileText, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { mailErrorMessage } from "./errorPresentation";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";
import { useStablePagedListHeight } from "./useStablePagedListHeight";
import type { MailTemplate, MailTemplateInput } from "./types";

export type TemplatesSectionProps = {
  demoMode?: boolean;
  /** Test seam: preloaded templates skip the API load. */
  initialTemplates?: MailTemplate[];
};

type TemplateDraft = {
  id?: string;
  name: string;
  subject: string;
  body: string;
};

type Notice = { kind: "success" | "error"; message: string } | null;

/** Templates past this count unlock the search / pagination / bulk toolbar. */
const TEMPLATES_PER_PAGE = 5;

function emptyDraft(): TemplateDraft {
  return { name: "", subject: "", body: "" };
}

export default function TemplatesSection({ demoMode = false, initialTemplates }: TemplatesSectionProps) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<MailTemplate[]>(initialTemplates ?? []);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!demoMode && initialTemplates === undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const confirmationDialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (demoMode || initialTemplates !== undefined) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    void api.templates().then((result) => {
      if (!active) return;
      setTemplates(result.items);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [demoMode, initialTemplates, loadAttempt]);

  const showToolbar = templates.length > TEMPLATES_PER_PAGE;

  const filteredTemplates = useMemo(() => {
    if (!showToolbar || !query.trim()) return templates;
    const needle = query.trim().toLocaleLowerCase();
    return templates.filter((template) => template.name.toLocaleLowerCase().includes(needle));
  }, [templates, query, showToolbar]);

  const pageCount = Math.max(1, Math.ceil(filteredTemplates.length / TEMPLATES_PER_PAGE));
  const clampedPage = Math.min(page, pageCount);
  const pageTemplates = useMemo(() => {
    if (!showToolbar) return filteredTemplates;
    const start = (clampedPage - 1) * TEMPLATES_PER_PAGE;
    return filteredTemplates.slice(start, start + TEMPLATES_PER_PAGE);
  }, [filteredTemplates, showToolbar, clampedPage]);

  // Keep the page and selection valid after templates change (e.g. removal).
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    const valid = new Set(templates.map((template) => template.id));
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
  }, [templates]);

  useDialogFocus(pendingBulkDelete, confirmationDialog);
  const { closing: confirmClosing, requestClose: requestConfirmClose } = useDismissTransition(() => setPendingBulkDelete(false));
  const { closing: editorClosing, requestClose: requestEditorClose } = useDismissTransition(() => {
    setDraft(null);
    setEditingId(null);
  });

  const controlsBusy = busy || Boolean(busyTemplateId);
  // Must run before any early return so the hook count stays stable across
  // renders (rules-of-hooks); it is inert while the pager is hidden.
  const listScroll = useStablePagedListHeight<HTMLDivElement>(showToolbar);

  const toggleSelect = (templateId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });
  };

  const allPageSelected = showToolbar && pageTemplates.length > 0 && pageTemplates.every((template) => selectedIds.has(template.id));

  const toggleAllPage = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allPageSelected) {
        for (const template of pageTemplates) next.delete(template.id);
      } else {
        for (const template of pageTemplates) next.add(template.id);
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
    for (const templateId of ids) {
      try {
        if (!demoMode) await api.deleteTemplate(templateId);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    setTemplates((current) => current.filter((template) => !ids.includes(template.id)));
    setPendingBulkDelete(false);
    setSelectedIds(new Set());
    if (failed) {
      setNotice({ kind: "error", message: t("settings.templates.bulkDeletedPartial", { removed, failed }) });
    } else {
      setNotice({ kind: "success", message: t("settings.templates.bulkDeleted", { count: removed }) });
    }
    setBusy(false);
  };

  if (demoMode) {
    return (
      <section className="settings-section" aria-labelledby="templates-settings">
        <div className="settings-section-title">
          <FileText size={16} />
          <div><span>{t("settings.templates.title")}</span><p id="templates-settings">{t("settings.templates.description")}</p></div>
        </div>
        <p className="settings-empty" role="status">{t("settings.templates.demoUnavailable")}</p>
      </section>
    );
  }

  const replaceTemplate = (updated: MailTemplate) => {
    setTemplates((current) => current.map((template) => template.id === updated.id ? updated : template));
  };

  const saveDraft = async () => {
    if (!draft || busy) return;
    const name = draft.name.trim();
    if (!name) {
      setNotice({ kind: "error", message: t("settings.templates.validation.nameRequired") });
      return;
    }
    if (!draft.body.trim()) {
      setNotice({ kind: "error", message: t("settings.templates.validation.bodyRequired") });
      return;
    }
    const input: MailTemplateInput = {
      name,
      ...(draft.subject.trim() ? { subject: draft.subject.trim() } : {}),
      body: draft.body.trim(),
    };
    setBusy(true);
    setNotice(null);
    try {
      if (draft.id) {
        const result = await api.updateTemplate(draft.id, input);
        replaceTemplate(result.template);
        setNotice({ kind: "success", message: t("settings.templates.updated") });
      } else {
        const result = await api.createTemplate(input);
        setTemplates((current) => [...current, result.template]);
        setNotice({ kind: "success", message: t("settings.templates.saved") });
      }
      setDraft(null);
      setEditingId(null);
    } catch (error) {
      setNotice({
        kind: "error",
        message: mailErrorMessage(error, t(draft.id ? "settings.templates.updateFailed" : "settings.templates.saveFailed"), t),
      });
    } finally {
      setBusy(false);
    }
  };

  const deleteTemplate = async (templateId: string) => {
    if (busyTemplateId) return;
    setBusyTemplateId(templateId);
    setNotice(null);
    try {
      await api.deleteTemplate(templateId);
      setTemplates((current) => current.filter((template) => template.id !== templateId));
      setArmedDeleteId(null);
      setNotice({ kind: "success", message: t("settings.templates.deleted") });
    } catch (error) {
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.templates.deleteFailed"), t) });
    } finally {
      setBusyTemplateId(null);
    }
  };

  const startEdit = (template: MailTemplate) => {
    setArmedDeleteId(null);
    setEditingId(template.id);
    setDraft({ id: template.id, name: template.name, subject: template.subject, body: template.body });
  };

  const cancelEdit = () => {
    setDraft(null);
    setEditingId(null);
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="templates-settings">
        <div className="settings-section-title">
          <FileText size={16} />
          <div><span>{t("settings.templates.title")}</span><p id="templates-settings">{t("settings.templates.description")}</p></div>
        </div>

        {notice && <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}{notice.message}</div>}

        {loading ? (
          <p className="settings-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("common.loading")}</p>
        ) : loadError ? (
          <div className="settings-empty translation-configuration-load-error" role="alert">
            <span>{mailErrorMessage(loadError, t("settings.templates.loadFailed"), t)}</span>
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              <RefreshCw size={15} aria-hidden="true" />{t("common.retry")}
            </button>
          </div>
        ) : (
          <>
            {showToolbar && (
              <div className="templates-toolbar">
                <label className="search-wrap templates-search" htmlFor="templates-search-input">
                  <Search size={14} aria-hidden="true" />
                  <input
                    id="templates-search-input"
                    type="search"
                    value={query}
                    placeholder={t("settings.templates.searchPlaceholder")}
                    aria-label={t("settings.templates.searchAriaLabel")}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                  />
                  {query && (
                    <button className="icon-button search-clear" type="button" aria-label={t("settings.templates.clearSearch")} onClick={() => setQuery("")}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                {selectedIds.size > 0 ? (
                  <div className="templates-bulk-actions">
                    <span className="templates-bulk-count">{t("settings.templates.selectedCount", { count: selectedIds.size })}</span>
                    <button className="secondary-button danger-button" type="button" disabled={controlsBusy} onClick={() => setPendingBulkDelete(true)}>
                      {busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{t("settings.templates.bulkDelete")}
                    </button>
                    <button className="secondary-button templates-bulk-clear" type="button" disabled={controlsBusy} onClick={() => setSelectedIds(new Set())}>
                      {t("settings.templates.clearSelection")}
                    </button>
                  </div>
                ) : (
                  <label className="templates-select-all">
                    <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} aria-label={t("settings.templates.selectAllAriaLabel")} />
                    {t("settings.templates.selectAll")}
                  </label>
                )}
              </div>
            )}

            {filteredTemplates.length === 0 ? (
              <p className="settings-empty">{showToolbar ? t("settings.templates.noSearchResults") : (templates.length === 0 ? t("settings.templates.empty") : t("settings.templates.noMatches"))}</p>
            ) : (
              <>
                {templates.some((template) => template.builtin) && (
                  <p className="templates-builtin-hint" role="note">{t("settings.templates.builtinHint")}</p>
                )}
                <div ref={listScroll.ref} className="templates-list" style={listScroll.style}>
                  {pageTemplates.map((template) => {
                    const deleting = busyTemplateId === template.id;
                    const selected = selectedIds.has(template.id);
                    return (
                      <div className={`template-row${selected ? " selected" : ""}`} key={template.id}>
                        {showToolbar && (
                          <label className="templates-row-check">
                            <input type="checkbox" checked={selected} onChange={() => toggleSelect(template.id)} aria-label={t("settings.templates.selectAriaLabel", { name: template.name })} />
                          </label>
                        )}
                        <div className="template-head">
                          <span className="template-icon" aria-hidden="true"><FileText size={16} /></span>
                          <div className="template-copy">
                            <strong>{template.name}{template.builtin && <em className="template-builtin-badge">{t("settings.templates.builtinBadge")}</em>}</strong>
                            {template.subject && <small className="template-subject">{template.subject}</small>}
                            <small className="template-preview">{template.body}</small>
                          </div>
                          <div className="template-actions">
                            <button className="icon-button" type="button" aria-label={t("settings.templates.edit")} data-tooltip={t("settings.templates.edit")} disabled={Boolean(busyTemplateId)} onClick={() => startEdit(template)}>
                              <Pencil size={15} />
                            </button>
                            {armedDeleteId === template.id ? (
                              <>
                                <button className="secondary-button danger-button" type="button" disabled={Boolean(busyTemplateId)} onClick={() => void deleteTemplate(template.id)}>
                                  {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.templates.confirmDelete")}
                                </button>
                                <button className="secondary-button" type="button" disabled={Boolean(busyTemplateId)} onClick={() => setArmedDeleteId(null)}>
                                  {t("common.cancel")}
                                </button>
                              </>
                            ) : (
                              <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.templates.delete")} data-tooltip={t("settings.templates.delete")} disabled={Boolean(busyTemplateId)} onClick={() => setArmedDeleteId(template.id)}>
                                <Trash2 size={15} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {showToolbar && pageCount > 1 && (
                  <div className="templates-pager">
                    <button className="secondary-button" type="button" disabled={controlsBusy || clampedPage <= 1} onClick={() => setPage(clampedPage - 1)} aria-label={t("settings.templates.pagerPrevious")}>
                      <ChevronLeft size={15} />{t("settings.templates.pagerPrevious")}
                    </button>
                    <span className="templates-pager-status" role="status">{t("settings.templates.pagerLabel", { page: clampedPage, total: pageCount })}</span>
                    <button className="secondary-button" type="button" disabled={controlsBusy || clampedPage >= pageCount} onClick={() => setPage(clampedPage + 1)} aria-label={t("settings.templates.pagerNext")}>
                      {t("settings.templates.pagerNext")}<ChevronRight size={15} />
                    </button>
                  </div>
                )}
              </>
            )}

            <div className="settings-inline-actions">
              <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => {
                setArmedDeleteId(null);
                setEditingId(null);
                setDraft(emptyDraft());
              }}>
                <Plus size={15} />{t("settings.templates.addTemplate")}
              </button>
            </div>
          </>
        )}
      </section>
      {draft && (
        <div className={`modal-backdrop settings-modal-backdrop${editorClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && requestEditorClose()}>
          <section className={`modal-card template-editor-card${editorClosing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="template-editor-title" tabIndex={-1}>
            <div className="modal-card-header">
              <span className="eyebrow">{editingId ? t("settings.templates.edit") : t("settings.templates.addTemplate")}</span>
              <h3 id="template-editor-title">{editingId ? t("settings.templates.editTitle") : t("settings.templates.addTitle")}</h3>
            </div>
            <div className="template-editor">
              <label className="translation-setting-field" htmlFor="template-editor-name">
                <span><strong>{t("settings.templates.nameLabel")}</strong></span>
                <input id="template-editor-name" type="text" value={draft.name} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} data-dialog-initial-focus />
              </label>
              <label className="translation-setting-field" htmlFor="template-editor-subject">
                <span><strong>{t("settings.templates.subjectLabel")}</strong><small>{t("settings.templates.subjectHint")}</small></span>
                <input id="template-editor-subject" type="text" value={draft.subject} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} />
              </label>
              <label className="translation-setting-field" htmlFor="template-editor-body">
                <span><strong>{t("settings.templates.bodyLabel")}</strong></span>
                <textarea id="template-editor-body" value={draft.body} rows={8} disabled={busy} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
              </label>
            </div>
            <div className="settings-inline-actions template-editor-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={requestEditorClose}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="button" disabled={busy || !draft.name.trim()} onClick={() => void saveDraft()}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t("settings.templates.save")}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingBulkDelete && (
        <div className={`modal-backdrop confirmation-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && requestConfirmClose()}>
          <section ref={confirmationDialog} className={`confirmation-card${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="templates-bulk-confirmation-title" aria-describedby="templates-bulk-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            <h3 id="templates-bulk-confirmation-title">{t("settings.templates.bulkDeleteTitle", { count: selectedIds.size })}</h3>
            <p id="templates-bulk-confirmation-description">{t("settings.templates.bulkDeleteDescription")}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={busy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
              <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => void removeSelected()}>
                {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.templates.bulkDeleteAction")}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
