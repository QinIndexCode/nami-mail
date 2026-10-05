import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Check, FileDown, LoaderCircle, MapPin, X } from "lucide-react";
import { parseIcs, type ParsedIcsEvent } from "@nami/agent-contracts";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useDismissTransition } from "../hooks/useDismissTransition";
import { FormNotice, type Notice } from "../FormNotice";

export type CalendarImportModalProps = {
  open: boolean;
  onClose: () => void;
  onSuccess: (count: number, replaced: boolean) => void;
  initialIcsContent?: string;
  initialFileName?: string;
  existingCount?: number;
};

export default function CalendarImportModal({
  open,
  onClose,
  onSuccess,
  initialIcsContent,
  initialFileName,
  existingCount = 0,
}: CalendarImportModalProps) {
  const { t } = useI18n();
  const [fileContent, setFileContent] = useState<string>(initialIcsContent ?? "");
  const [fileName, setFileName] = useState<string>(initialFileName ?? "");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { closing, requestClose, reset } = useDismissTransition(onClose);
  const modalRef = useRef<HTMLElement>(null);
  useDialogFocus(open && !closing, modalRef);

  useEffect(() => {
    if (open) {
      reset();
      if (initialIcsContent) {
        setFileContent(initialIcsContent);
        setFileName(initialFileName ?? "invitation.ics");
      }
    }
  }, [open, initialIcsContent, initialFileName, reset]);

  const parsedEvents = useMemo<ParsedIcsEvent[]>(() => {
    if (!fileContent.trim()) return [];
    try {
      return parseIcs(fileContent);
    } catch {
      return [];
    }
  }, [fileContent]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Mirror the server's import cap before reading: a >10MB file would just
    // fail server-side anyway, so fail fast with a clear local message.
    if (file.size > 10_000_000) {
      setFileContent("");
      setNotice({ kind: "error", message: t("calendar.importOversized") });
      return;
    }
    setNotice(null);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = typeof event.target?.result === "string" ? event.target.result : "";
      setFileContent(text);
      if (!text.trim() || parseIcs(text).length === 0) {
        setNotice({ kind: "error", message: t("calendar.importParseError") });
      }
    };
    reader.readAsText(file);
  }, [t]);

  const handleConfirmImport = useCallback(async () => {
    if (parsedEvents.length === 0) {
      setNotice({ kind: "error", message: t("calendar.importParseError") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const payload = parsedEvents.map((evt) => ({
        uid: evt.uid,
        title: evt.title,
        description: evt.description || undefined,
        location: evt.location || undefined,
        startAt: evt.startAt,
        endAt: evt.endAt,
        allDay: evt.allDay,
        color: evt.color,
      }));
      const res = await api.importCalendarEvents(payload, mode);
      if (res.ok) {
        // Updated events count toward the summary: from the user's view the
        // calendar now holds that many imported entries.
        onSuccess(res.imported + res.updated, res.replaced);
        requestClose();
      } else {
        setNotice({ kind: "error", message: t("calendar.loadError") });
      }
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : t("calendar.loadError") });
    } finally {
      setBusy(false);
    }
  }, [parsedEvents, mode, onSuccess, requestClose, t]);

  if (!open && !closing) return null;

  return (
    <div
      className={`modal-backdrop calendar-editor-backdrop${closing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) requestClose();
      }}
    >
      <section
        ref={modalRef}
        className={`calendar-editor-modal calendar-import-modal${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("calendar.importModalTitle")}
        tabIndex={-1}
      >
        <div className="calendar-editor-header">
          <div className="calendar-editor-title-wrap">
            <CalendarDays size={18} className="calendar-editor-icon" />
            <h2 className="calendar-editor-title">{t("calendar.importModalTitle")}</h2>
          </div>
          <button
            type="button"
            className="icon-button calendar-editor-close"
            disabled={busy}
            onClick={requestClose}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <FormNotice notice={notice} />

        <div className="calendar-import-body">
          {!fileContent ? (
            <div className="calendar-import-upload-zone" onClick={() => fileInputRef.current?.click()}>
              <FileDown size={32} className="calendar-import-upload-icon" />
              <p className="calendar-import-upload-text">{t("calendar.importSelectFile")}</p>
              <button type="button" className="secondary-button calendar-import-pick-btn">
                {t("calendar.importChooseFile")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ics,text/calendar"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
            </div>
          ) : (
            <>
              <div className="calendar-import-meta">
                <span className="calendar-import-filename" title={fileName}>{fileName}</span>
                <span className="calendar-import-badge">
                  {t("calendar.importSummary", { count: parsedEvents.length })}
                </span>
              </div>

              {parsedEvents.length > 0 && (
                <div className="calendar-import-preview-section">
                  <h4 className="calendar-import-section-title">{t("calendar.importPreviewTitle")}</h4>
                  <div className="calendar-import-preview-list">
                    {parsedEvents.slice(0, 4).map((evt, idx) => (
                      <div key={idx} className="calendar-import-preview-item">
                        <span className={`calendar-event-dot dot-${evt.color || "blue"}`} />
                        <div className="calendar-import-preview-content">
                          <strong className="calendar-import-preview-title">{evt.title}</strong>
                          <span className="calendar-import-preview-time">
                            {new Date(evt.startAt).toLocaleDateString()}
                            {!evt.allDay && ` ${new Date(evt.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                          </span>
                          {evt.location && (
                            <span className="calendar-import-preview-loc">
                              <MapPin size={11} />
                              {evt.location}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    {parsedEvents.length > 4 && (
                      <div className="calendar-import-preview-more">
                        {t("calendar.moreEvents", { count: parsedEvents.length - 4 })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="calendar-import-mode-section">
                <label className="calendar-field-label">{t("calendar.importModeLabel")}</label>
                <div className="calendar-import-modes">
                  <label className={`calendar-import-mode-card${mode === "append" ? " is-active" : ""}`}>
                    <input
                      type="radio"
                      name="import-mode"
                      value="append"
                      checked={mode === "append"}
                      onChange={() => setMode("append")}
                    />
                    <div className="calendar-import-mode-info">
                      <span className="calendar-import-mode-title">{t("calendar.importModeAppend")}</span>
                      <span className="calendar-import-mode-hint">{t("calendar.importModeAppendHint")}</span>
                    </div>
                  </label>

                  <label className={`calendar-import-mode-card${mode === "replace" ? " is-active" : ""}`}>
                    <input
                      type="radio"
                      name="import-mode"
                      value="replace"
                      checked={mode === "replace"}
                      onChange={() => setMode("replace")}
                    />
                    <div className="calendar-import-mode-info">
                      <span className="calendar-import-mode-title">{t("calendar.importModeReplace")}</span>
                      <span className="calendar-import-mode-hint">{t("calendar.importModeReplaceHint")}</span>
                    </div>
                  </label>
                </div>

                {mode === "replace" && (
                  <div className="calendar-import-warning-box">
                    <AlertTriangle size={15} />
                    <span>
                      {existingCount > 0
                        ? `${t("calendar.importModeReplaceWarning")}（将清除现有 ${existingCount} 个日程）`
                        : t("calendar.importModeReplaceWarning")}
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="calendar-editor-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={requestClose}
          >
            {t("common.cancel")}
          </button>
          {fileContent && (
            <button
              type="button"
              className="primary-button calendar-import-submit-btn"
              disabled={busy || parsedEvents.length === 0}
              onClick={() => void handleConfirmImport()}
            >
              {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
              <span>{t("calendar.importConfirmAction")}</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
