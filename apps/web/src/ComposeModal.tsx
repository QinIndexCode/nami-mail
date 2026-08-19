import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from "react";
import { CalendarClock, FilePenLine, LayoutTemplate, LoaderCircle, Paperclip, RefreshCw, Send, Trash2, X } from "lucide-react";
import { api } from "./api";
import { presentAttachment } from "./attachmentPresentation";
import { summarizeComposeAttachments } from "./attachmentWorkflow";
import { mailErrorMessage } from "./errorPresentation";
import { applyTemplateToDraft } from "./mailTemplateInsert";
import { pollSubmittingSubmission } from "./sendingStatus";
import DatePicker from "./DatePicker";
import ThemedSelect from "./ThemedSelect";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";
import { useI18n } from "./i18n";
import type { Account, Contact, MailTemplate, OutboundAttachment } from "./types";
import { AttachmentFileIcon, formatFileSize, datetimeLocalFromDate, isoFromDatetimeLocal, IconButton, type ComposeDraft, type PendingAttachmentUpload, type ToastKind } from "./mailUi";

const isDemo = new URLSearchParams(window.location.search).get("demo") === "1";

function createLocalId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

function createSubmissionIdempotencyKey(): string {
  return createLocalId("sub");
}

export function ComposeModal({ accounts, draft, onClose, onSent, onDraftSaved, onDraftDiscarded, onSubmissionChanged, fallbackFocusRef }: { accounts: Account[]; draft: ComposeDraft; onClose: () => void; onSent: (message: string, kind?: ToastKind, undoDraft?: ComposeDraft) => void; onDraftSaved: (accountId: string) => void; onDraftDiscarded: (messageId: string) => void; onSubmissionChanged: () => void; fallbackFocusRef?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const signatureForAccount = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.signature ?? "";
  const initialAccountId = draft.accountId ?? accounts[0]?.id ?? "";
  const initialBodyText = draft.text?.trim() ? draft.text : signatureForAccount(initialAccountId);
  const [accountId, setAccountId] = useState(initialAccountId);
  const [to, setTo] = useState(draft.to ?? "");
  const [cc, setCc] = useState(draft.cc ?? "");
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [text, setText] = useState(initialBodyText);
  const [attachments, setAttachments] = useState<OutboundAttachment[]>(draft.attachments ?? []);
  const [pendingUploads, setPendingUploads] = useState<PendingAttachmentUpload[]>([]);
  const [recentAttachmentTokens, setRecentAttachmentTokens] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"discard" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [deliveryNotice, setDeliveryNotice] = useState("");
  const [sendAtLocal, setSendAtLocal] = useState("");
  const [toSuggestions, setToSuggestions] = useState<Contact[]>([]);
  const [toSuggestionsOpen, setToSuggestionsOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [composeTemplates, setComposeTemplates] = useState<MailTemplate[] | null>(null);
  const [templateLoadBusy, setTemplateLoadBusy] = useState(false);
  const [templateLoadFailed, setTemplateLoadFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composeDialogRef = useRef<HTMLElement>(null);
  const discardConfirmDialogRef = useRef<HTMLElement>(null);
  const submissionAttemptRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const uploadInFlightRef = useRef(false);
  const toSearchRef = useRef(0);
  const initialDraftRef = useRef({
    accountId: initialAccountId,
    to: draft.to ?? "",
    cc: draft.cc ?? "",
    subject: draft.subject ?? "",
    text: initialBodyText,
    attachmentTokens: (draft.attachments ?? []).map((attachment) => attachment.token).join("\u001f"),
  });

  const recipients = () => to.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
  const copiedRecipients = () => cc.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
  // Debounced address-book lookup for recipient autocomplete. The lookup is a
  // local encrypted store, so suggestions never leave the machine.
  const searchContacts = (value: string) => {
    const requestId = ++toSearchRef.current;
    const needle = value.trim();
    if (isDemo || !needle) {
      setToSuggestions([]);
      setToSuggestionsOpen(false);
      return;
    }
    window.setTimeout(() => {
      if (toSearchRef.current !== requestId) return;
      void api.contacts(needle, 8).then((result) => {
        if (toSearchRef.current !== requestId) return;
        setToSuggestions(result.items);
        setToSuggestionsOpen(result.items.length > 0);
      }).catch(() => {
        if (toSearchRef.current !== requestId) return;
        setToSuggestions([]);
        setToSuggestionsOpen(false);
      });
    }, 180);
  };
  const applyRecipientSuggestion = (contact: Contact) => {
    const parts = to.split(",");
    const lastPart = parts.pop() ?? "";
    setTo(to.slice(0, to.length - lastPart.length) + contact.email);
    setToSuggestions([]);
    setToSuggestionsOpen(false);
    toSearchRef.current += 1;
  };
  // Template quick-reply: templates are a local encrypted store, so the
  // picker loads only on first open and never sends template text anywhere.
  const loadComposeTemplates = async () => {
    if (isDemo || composeTemplates) return;
    setTemplateLoadBusy(true);
    setTemplateLoadFailed(false);
    try {
      const result = await api.templates();
      setComposeTemplates(result.items);
    } catch {
      setTemplateLoadFailed(true);
    } finally {
      setTemplateLoadBusy(false);
    }
  };
  const toggleTemplatePicker = () => {
    if (busy || discarding) return;
    if (templatePickerOpen) {
      setTemplatePickerOpen(false);
      return;
    }
    setTemplatePickerOpen(true);
    void loadComposeTemplates();
  };
  const applyTemplate = (template: MailTemplate) => {
    const applied = applyTemplateToDraft({ subject, body: text }, template);
    setSubject(applied.subject);
    setText(applied.body);
    setTemplatePickerOpen(false);
    onSent(t("compose.templates.inserted"));
  };
  const initialDraft = initialDraftRef.current;
  const uploading = pendingUploads.some((upload) => upload.phase === "uploading");
  const hasPendingUploads = pendingUploads.length > 0;
  const hasUploadErrors = pendingUploads.some((upload) => upload.phase === "error");
  const scheduled = Boolean(sendAtLocal);
  // Quick schedule presets the compose window offers next to the custom field.
  const scheduleOptions = useMemo(() => [
    { key: "inOneHour", label: t("compose.schedule.inOneHour"), compute: () => new Date(Date.now() + 60 * 60_000) },
    { key: "tonight", label: t("compose.schedule.tonight"), compute: () => {
      const date = new Date();
      date.setHours(23, 0, 0, 0);
      if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
      return date;
    } },
    { key: "tomorrowMorning", label: t("compose.schedule.tomorrowMorning"), compute: () => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date;
    } },
    { key: "nextMondayMorning", label: t("compose.schedule.nextMondayMorning"), compute: () => {
      const date = new Date();
      const daysUntilMonday = date.getDay() === 0 ? 1 : 8 - date.getDay();
      date.setDate(date.getDate() + daysUntilMonday);
      date.setHours(9, 0, 0, 0);
      return date;
    } },
  ], [t]);
  const attachmentSummary = summarizeComposeAttachments(attachments, pendingUploads);
  const attachmentStatus = [
    attachmentSummary.uploadingCount > 0 ? t("compose.attachment.uploadingCount", { count: attachmentSummary.uploadingCount }) : "",
    attachmentSummary.failedCount > 0 ? t("compose.attachment.failedCount", { count: attachmentSummary.failedCount }) : "",
  ].filter(Boolean).join(t("common.dotSeparator"));
  const hasUnsavedChanges = accountId !== initialDraft.accountId
    || to !== initialDraft.to
    || cc !== initialDraft.cc
    || subject !== initialDraft.subject
    || text !== initialDraft.text
    || attachments.map((attachment) => attachment.token).join("\u001f") !== initialDraft.attachmentTokens
    || hasPendingUploads;

  const { closing, requestClose: requestExit } = useDismissTransition(() => {
    onClose();
  });
  const { closing: confirmClosing, requestClose: requestConfirmClose, reset: resetConfirmClosing } = useDismissTransition(() => setConfirmAction(null));

  const requestClose = useCallback(() => {
    if (busy || uploading || discarding) return;
    if (hasUnsavedChanges) {
      resetConfirmClosing();
      setConfirmAction("discard");
      return;
    }
    requestExit();
  }, [busy, discarding, hasUnsavedChanges, requestExit, resetConfirmClosing, uploading]);

  useDialogFocus(true, composeDialogRef, { fallbackFocusRef, suspended: Boolean(confirmAction) });
  useDialogFocus(Boolean(confirmAction), discardConfirmDialogRef);

  const discardAndClose = async () => {
    if (busy || uploading || discarding) return;
    setDiscarding(true);
    setError("");
    try {
      if (!isDemo && accountId && attachments.length) {
        await api.discardOutboundAttachments(accountId, attachments.map((attachment) => attachment.token));
      }
      requestExit();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.cleanupAttachments"), t));
      setConfirmAction(null);
    } finally {
      setDiscarding(false);
    }
  };

  const deleteSavedDraft = async () => {
    if (!draft.sourceDraftId || busy || uploading || discarding) return;
    setDiscarding(true);
    setError("");
    try {
      if (!isDemo) await api.discardDraft(draft.sourceDraftId);
      onDraftDiscarded(draft.sourceDraftId);
      requestExit();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.deleteDraft"), t));
      setConfirmAction(null);
    } finally {
      setDiscarding(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (confirmAction) {
        requestConfirmClose();
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmAction, requestClose, requestConfirmClose]);

  const chooseFiles = () => fileInputRef.current?.click();

  const uploadAttachment = async (targetAccountId: string, uploadId: string, file: File) => {
    try {
      const attachment = isDemo
        ? {
          token: createLocalId("demo-attachment"),
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        }
        : await api.uploadOutboundAttachment(targetAccountId, file);
      setAttachments((current) => [...current, attachment]);
      setRecentAttachmentTokens((current) => new Set(current).add(attachment.token));
      setPendingUploads((current) => current.filter((upload) => upload.id !== uploadId));
    } catch (reason) {
      const detail = mailErrorMessage(reason, t("compose.error.uploadAttachment"), t);
      setPendingUploads((current) =>
        current.map((upload) => upload.id === uploadId ? { ...upload, phase: "error", retryable: true, error: detail } : upload));
    }
  };

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length || busy || uploading || uploadInFlightRef.current) return;
    if (!accountId) {
      setError(t("compose.error.selectSender"));
      return;
    }
    const validFiles = files.filter((file) => file.size > 0 && file.size <= 10 * 1024 * 1024);
    if (attachmentSummary.reservedCount + validFiles.length > 10) {
      setError(t("compose.error.maxAttachments"));
      return;
    }
    const totalSize = attachmentSummary.reservedBytes + validFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > 25 * 1024 * 1024) {
      setError(t("compose.error.maxAttachmentSize"));
      return;
    }

    const nextUploads: PendingAttachmentUpload[] = files.map((file) => {
      const error = file.size <= 0
        ? t("compose.error.emptyAttachment")
        : file.size > 10 * 1024 * 1024
          ? t("compose.error.maxSingleAttachmentSize")
          : undefined;
      return { id: createLocalId("upload"), file, phase: error ? "error" : "uploading", retryable: !error, error };
    });
    setPendingUploads((current) => [...current, ...nextUploads]);
    setError("");
    uploadInFlightRef.current = true;
    try {
      for (const upload of nextUploads) {
        if (upload.phase === "uploading") await uploadAttachment(accountId, upload.id, upload.file);
      }
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const retryPendingUpload = async (upload: PendingAttachmentUpload) => {
    if (!accountId || !upload.retryable || busy || uploading || discarding || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setError("");
    setPendingUploads((current) => current.map((item) => item.id === upload.id
      ? { ...item, phase: "uploading", error: undefined }
      : item));
    try {
      await uploadAttachment(accountId, upload.id, upload.file);
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const removePendingUpload = (uploadId: string) => {
    if (busy || uploading || discarding) return;
    setPendingUploads((current) => current.filter((upload) => upload.id !== uploadId));
  };

  const removeAttachment = async (attachment: OutboundAttachment) => {
    if (busy || uploading || discarding) return;
    setError("");
    try {
      if (!isDemo && accountId) await api.discardOutboundAttachments(accountId, [attachment.token]);
      setAttachments((current) => current.filter((item) => item.token !== attachment.token));
      setRecentAttachmentTokens((current) => {
        const next = new Set(current);
        next.delete(attachment.token);
        return next;
      });
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.removeAttachment"), t));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || uploading || discarding) return;
    if (hasPendingUploads) {
      setError(t("compose.error.pendingAttachments"));
      return;
    }
    const recipientValues = recipients();
    const ccValues = copiedRecipients();
    if (!accountId) {
      setError(t("compose.error.selectSender"));
      return;
    }
    if (!recipientValues.length) {
      setError(t("compose.error.recipientRequired"));
      return;
    }
    if ([...recipientValues, ...ccValues].some((recipient) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) {
      setError(t("compose.error.recipientInvalid"));
      return;
    }
    if (!text.trim() && !attachments.length) {
      setError(t("compose.error.messageRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setDeliveryNotice("");
    try {
      if (!isDemo) {
        const sendRequest = {
          accountId,
          to: recipientValues,
          cc: ccValues.length ? ccValues : undefined,
          subject,
          text,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          discardDraftId: draft.sourceDraftId,
          attachmentTokens: attachments.map((attachment) => attachment.token),
          ...(sendAtLocal ? { sendAt: isoFromDatetimeLocal(sendAtLocal) } : {}),
        };
        const fingerprint = JSON.stringify(sendRequest);
        if (submissionAttemptRef.current?.fingerprint !== fingerprint) {
          submissionAttemptRef.current = { fingerprint, idempotencyKey: createSubmissionIdempotencyKey() };
        }
        const result = await api.send({
          ...sendRequest,
          idempotencyKey: submissionAttemptRef.current.idempotencyKey,
        });
        onSubmissionChanged();
        if (result.scheduled) {
          // The send is parked in the local queue until sendAt. The draft
          // stays in place so the user can still cancel or edit it.
          onSent(t("compose.delivery.scheduled"));
          onClose();
          return;
        }
        let submission = result.submission;
        if (submission.deliveryStatus === "submitting") {
          try {
            submission = await pollSubmittingSubmission(
              submission,
              async (id) => (await api.submission(id)).submission,
            );
          } catch {
            // The durable record remains `submitting`. Keep the compose
            // window open so a transient local API failure cannot discard.
          }
          onSubmissionChanged();
          if (submission.deliveryStatus === "submitting") {
            setDeliveryNotice(t("compose.delivery.waitingNotice"));
            onSent(t("compose.delivery.waitingToast"), "info");
            return;
          }
          if (submission.deliveryStatus === "failed") {
            setError(mailErrorMessage(
              { code: submission.errorCode ?? undefined, message: submission.errorMessage ?? "" },
              t("compose.error.sendRejected"),
              t,
            ));
            return;
          }
        }
        if (submission.deliveryStatus === "unknown_delivery") {
          onSent(
            t("compose.delivery.unknown"),
            "warning",
          );
        } else {
          if (draft.sourceDraftId && !result.draftDiscardWarning) onDraftDiscarded(draft.sourceDraftId);
          const deliveryMessage = submission.deliveryStatus === "confirmed"
            ? t("compose.delivery.confirmed")
            : t("compose.delivery.submitted");
          onSent(result.draftDiscardWarning ? t("compose.delivery.previousDraftRemains", { message: deliveryMessage }) : deliveryMessage);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 650));
        onSent(scheduled ? t("compose.delivery.demoScheduled") : t("compose.delivery.demoSent"), undefined, { accountId: draft.accountId, to, cc, subject, text });
      }
      onClose();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.send"), t));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!accountId || busy || uploading || discarding) return;
    if (hasPendingUploads) {
      setError(t("compose.error.pendingAttachments"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!isDemo) {
        const result = await api.saveDraft({
          accountId,
          to: recipients(),
          cc: copiedRecipients(),
          subject,
          text,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          replaceDraftId: draft.sourceDraftId,
          attachmentTokens: attachments.map((attachment) => attachment.token),
        });
        if (!result.serverConfirmed) {
          setError(t("compose.error.draftUnconfirmed"));
          return;
        }
        if (draft.sourceDraftId && !result.replaceWarning) onDraftDiscarded(draft.sourceDraftId);
        const warnings = [
          result.replaceWarning ? t("compose.save.replaceWarning") : "",
          result.attachmentWarning ? t("compose.save.attachmentWarning") : "",
        ].filter(Boolean);
        onSent(warnings.length ? t("compose.save.confirmedWithWarnings", { warnings: warnings.join(t("common.listSeparator")) }) : t("compose.save.confirmed"));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 380));
        onSent(t("compose.save.demo"));
      }
      onDraftSaved(accountId);
      onClose();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.saveDraft"), t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`modal-backdrop compose-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (confirmAction) requestConfirmClose();
      else requestClose();
    }}>
      <section ref={composeDialogRef} className={`compose-card${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="compose-title" tabIndex={-1}>
        <header className="compose-header">
          <div><span className="eyebrow">{draft.sourceDraftId ? t("compose.draft") : t("compose.new")}</span><h2 id="compose-title">{draft.sourceDraftId ? t("compose.editDraft") : t("compose.new")}</h2></div>
          <div className="compose-header-actions">{draft.sourceDraftId && <IconButton label={t("compose.deleteDraft")} onClick={() => { resetConfirmClosing(); setConfirmAction("delete"); }} disabled={busy || uploading || discarding}><Trash2 size={18} /></IconButton>}<IconButton label={t("common.close")} onClick={requestClose} disabled={busy || uploading || discarding}><X size={18} /></IconButton></div>
        </header>
        <form noValidate onSubmit={submit}>
          <label className="compose-row" htmlFor="compose-account"><span>{t("compose.sender")}</span><ThemedSelect id="compose-account" value={accountId} onValueChange={(value) => {
            if ((attachments.length || pendingUploads.length) && value !== accountId) {
              setError(t("compose.error.senderLocked"));
              return;
            }
            const previousSignature = signatureForAccount(accountId);
            const bodyIsOnlySignature = text.trim() === previousSignature.trim();
            setAccountId(value);
            if (bodyIsOnlySignature || !text.trim()) {
              setText(signatureForAccount(value));
            }
          }} disabled={busy || uploading || discarding}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</ThemedSelect></label>
          <div className="compose-row compose-to-row">
            <label htmlFor="compose-to"><span>{t("compose.to")}</span><input id="compose-to" type="text" data-dialog-initial-focus value={to} onChange={(event) => { setTo(event.target.value); searchContacts(event.target.value); }} onKeyDown={(event) => { if (event.key === "Escape") setToSuggestionsOpen(false); }} placeholder="email@example.com" disabled={busy || discarding} /></label>
            {toSuggestionsOpen && (
              <div className="compose-contact-suggestions" role="listbox" aria-label={t("compose.contactSuggestions")}>
                {toSuggestions.map((contact) => (
                  <button key={contact.id} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => applyRecipientSuggestion(contact)}>
                    <span>{contact.name || contact.email}</span><small>{contact.name ? contact.email : ""}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="compose-row" htmlFor="compose-cc"><span>{t("compose.cc")}</span><input id="compose-cc" type="text" value={cc} onChange={(event) => setCc(event.target.value)} placeholder={t("compose.ccPlaceholder")} disabled={busy || discarding} /></label>
          <label className="compose-row" htmlFor="compose-subject"><span>{t("compose.subject")}</span><input id="compose-subject" type="text" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder={t("compose.subjectPlaceholder")} disabled={busy || discarding} /></label>
          <label className="compose-row compose-schedule-row" htmlFor="compose-schedule"><span><CalendarClock size={14} />{t("compose.schedule")}</span><span className="compose-schedule-field"><CalendarClock size={15} className="compose-schedule-icon" /><DatePicker mode="datetime" value={sendAtLocal} onChange={setSendAtLocal} disabled={busy || discarding} aria-label={t("compose.schedule")} />{sendAtLocal ? <button className="compose-schedule-clear" type="button" onClick={() => setSendAtLocal("")} disabled={busy || discarding} aria-label={t("compose.schedule.clear")}><X size={15} /></button> : null}</span></label>
          <div className="compose-schedule-quick" role="group" aria-label={t("compose.schedule.quickLabel")}>
            {scheduleOptions.map((option) => (
              <button key={option.key} type="button" className={`schedule-chip${sendAtLocal === datetimeLocalFromDate(option.compute()) ? " active" : ""}`} onClick={() => setSendAtLocal(datetimeLocalFromDate(option.compute()))} disabled={busy || discarding}>{option.label}</button>
            ))}
            <button className="secondary-button compose-template-toggle" type="button" disabled={busy || discarding} onClick={toggleTemplatePicker}><LayoutTemplate size={15} />{t("compose.templates")}</button>{templatePickerOpen && (
              <div className="compose-template-picker" role="listbox" aria-label={t("compose.templates")}>
                {isDemo ? (
                  <p className="compose-template-empty" role="status">{t("compose.templates.demoUnavailable")}</p>
                ) : templateLoadBusy ? (
                  <p className="compose-template-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("common.loading")}</p>
                ) : templateLoadFailed ? (
                  <div className="compose-template-empty" role="alert">
                    <span>{t("compose.templates.loadFailed")}</span>
                    <button className="secondary-button" type="button" onClick={() => void loadComposeTemplates()}>
                      <RefreshCw size={14} aria-hidden="true" />{t("common.retry")}
                    </button>
                  </div>
                ) : composeTemplates && composeTemplates.length === 0 ? (
                  <p className="compose-template-empty" role="status">{t("compose.templates.empty")}</p>
                ) : (
                  <ul className="compose-template-list">
                    {composeTemplates?.map((template) => (
                      <li key={template.id}>
                        <button type="button" role="option" onClick={() => applyTemplate(template)}>
                          <span>{template.name}</span>
                          {template.subject && <small>{template.subject}</small>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <label className="visually-hidden" htmlFor="compose-body">{t("compose.body")}</label>
          <textarea id="compose-body" className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("compose.bodyPlaceholder")} disabled={busy || discarding} />
          <section className="compose-attachments" aria-label={t("compose.attachment.aria", { count: attachmentSummary.attachedCount, status: attachmentStatus })}>
            <div className="compose-attachments-heading"><span><Paperclip size={16} />{t("compose.attachments")}</span><small aria-live="polite">{attachmentSummary.attachedCount} / 10{t("common.dotSeparator")}{formatFileSize(attachmentSummary.attachedBytes)}{attachmentStatus ? `${t("common.dotSeparator")}${attachmentStatus}` : ""}</small><button className="compose-attachment-add" type="button" onClick={chooseFiles} disabled={busy || uploading || discarding || !accountId}>{uploading ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}{uploading ? t("compose.attachment.uploading") : t("compose.attachment.add")}</button></div>
            <input ref={fileInputRef} className="visually-hidden" type="file" tabIndex={-1} multiple onChange={(event) => void addFiles(event)} />
            {(attachments.length > 0 || pendingUploads.length > 0) && <div className="compose-attachment-list">{attachments.map((attachment) => {
              const presentation = presentAttachment(attachment.filename, attachment.contentType, t);
              const recentlyAdded = recentAttachmentTokens.has(attachment.token);
              return <div className={`compose-attachment-item${recentlyAdded ? " is-success" : ""}`} key={attachment.token}><AttachmentFileIcon kind={presentation.kind} /><span><strong className="truncated-tooltip" data-tooltip={attachment.filename}><span>{attachment.filename}</span></strong><small aria-live={recentlyAdded ? "polite" : undefined}>{recentlyAdded ? `${t("compose.attachment.added")}${t("common.dotSeparator")}` : ""}{presentation.label}{t("common.dotSeparator")}{formatFileSize(attachment.size)}</small></span><IconButton label={t("compose.attachment.remove", { filename: attachment.filename })} onClick={() => void removeAttachment(attachment)} disabled={busy || uploading || discarding}><X size={16} /></IconButton></div>;
            })}{pendingUploads.map((upload) => {
              const presentation = presentAttachment(upload.file.name, upload.file.type || "application/octet-stream", t);
              const isUploading = upload.phase === "uploading";
              const isRetryable = !isUploading && upload.retryable;
              return <div className={`compose-attachment-item is-${upload.phase}${isRetryable ? " has-retry" : ""}`} key={upload.id}><AttachmentFileIcon kind={presentation.kind} /><span><strong className="truncated-tooltip" data-tooltip={upload.file.name}><span>{upload.file.name}</span></strong><small className="truncated-tooltip" aria-live="polite" data-tooltip={upload.error}><span>{isUploading ? t("compose.attachment.uploadingEllipsis") : upload.error}</span></small></span>{isUploading ? <span className="attachment-transfer-state" role="status" aria-label={t("compose.attachment.uploadingFile", { filename: upload.file.name })}><LoaderCircle className="spin" size={16} /></span> : <span className="attachment-upload-actions">{isRetryable && <IconButton label={t("compose.attachment.retry", { filename: upload.file.name })} onClick={() => void retryPendingUpload(upload)} disabled={busy || uploading || discarding}><RefreshCw size={16} /></IconButton>}<IconButton label={t("compose.attachment.remove", { filename: upload.file.name })} onClick={() => removePendingUpload(upload.id)} disabled={busy || uploading || discarding}><X size={16} /></IconButton></span>}</div>;
            })}</div>}
            {hasPendingUploads && <p className={`compose-attachment-hint${hasUploadErrors ? " error" : ""}`} role={hasUploadErrors ? "alert" : "status"}>{hasUploadErrors ? t("compose.attachment.failedHint") : t("compose.attachment.uploadingHint")}</p>}
          </section>
          {deliveryNotice && <div className="form-status warning" role="status"><LoaderCircle className="spin" size={17} />{deliveryNotice}</div>}
          {error && <div id="compose-error" className="form-status error" role="alert"><X size={17} />{error}</div>}
          <footer className="compose-footer">
            <button className="secondary-button" type="button" disabled={busy || uploading || discarding || hasPendingUploads || !accountId} onClick={() => void saveDraft()}>{busy ? <LoaderCircle className="spin" size={17} /> : <FilePenLine size={17} />}{t("compose.saveDraft")}</button>
            <button className="primary-button" type="submit" disabled={busy || uploading || discarding || hasPendingUploads || !accountId}>{busy ? <LoaderCircle className="spin" size={17} /> : scheduled ? <CalendarClock size={17} /> : <Send size={17} />}{busy ? t("compose.sending") : scheduled ? t("compose.scheduleSend") : t("compose.send")}</button>
          </footer>
        </form>
        {confirmAction && (
          <div className={`compose-confirm-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) requestConfirmClose();
          }}>
            <section ref={discardConfirmDialogRef} className={`compose-confirm${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="discard-compose-title" aria-describedby="discard-compose-copy" tabIndex={-1}>
              <h3 id="discard-compose-title">{confirmAction === "delete" ? t("compose.confirm.deleteTitle") : t("compose.confirm.discardTitle")}</h3>
              <p id="discard-compose-copy">{confirmAction === "delete" ? t("compose.confirm.deleteDescription") : t("compose.confirm.discardDescription")}</p>
              <div><button className="secondary-button" type="button" onClick={requestConfirmClose} disabled={discarding}>{confirmAction === "delete" ? t("compose.confirm.keepDraft") : t("compose.confirm.continueEditing")}</button><button className="danger-button" type="button" onClick={() => void (confirmAction === "delete" ? deleteSavedDraft() : discardAndClose())} disabled={discarding}>{discarding ? t("compose.processing") : confirmAction === "delete" ? t("compose.deleteDraft") : t("compose.confirm.discardAction")}</button></div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}