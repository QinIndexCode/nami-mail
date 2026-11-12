import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, CircleAlert, CircleHelp, Download, Info, KeyRound, Upload, Users, X } from "lucide-react";
import { ownObjectUrl, ResourceScope } from "../attachments/document";
import ThemedSelect from "../ThemedSelect";
import { request } from "../api";
import { useI18n } from "../i18n";
import { IMAGE_POLICY_CHANGED, type ImagePolicy } from "../imagePrivacy";
import { activateApplicationBackup, exportApplicationBackup, previewApplicationBackup, type RestorePreview } from "../dataRecoveryApi";
import { useDialogFocus } from "../hooks/useDialogFocus";

type DataDialogId = "trusted" | "export" | "restore";

/** Explicit icon slot size; the glyph fills the slot, so nothing is nudged by margins. */
const iconSize = (size: string): CSSProperties => ({ "--icon-size": size } as CSSProperties);

function DataNote({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" }) {
  const Icon = tone === "warning" ? CircleAlert : Info;
  return (
    <p className={`settings-data-note${tone === "warning" ? " is-warning" : ""}`}>
      <span className="settings-data-icon" style={iconSize("14px")} aria-hidden="true"><Icon /></span>
      <span className="settings-data-note-text">{children}</span>
    </p>
  );
}

type DataDialogProps = {
  titleId: string;
  title: string;
  icon: ReactNode;
  /** Supplementary copy that only matters when asked for; the same hover-only
   *  question-mark pattern the rest of the settings surfaces use. */
  hint?: string;
  dialogRef: RefObject<HTMLElement | null>;
  busy: boolean;
  closeLabel: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
};

function DataDialog({ titleId, title, icon, hint, dialogRef, busy, closeLabel, onClose, footer, children }: DataDialogProps) {
  return createPortal(
    <div
      className="modal-backdrop confirmation-backdrop settings-data-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <section
        ref={dialogRef}
        className="contact-editor-modal settings-model-modal settings-data-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="settings-model-head settings-data-dialog-head">
          <span className="settings-data-icon" style={iconSize("18px")} aria-hidden="true">{icon}</span>
          <h3 className="settings-model-title" id={titleId}>{title}</h3>
          {hint ? <span className="field-help-icon settings-data-dialog-help" data-tooltip={hint} aria-label={hint} tabIndex={0}>
            <span className="settings-data-icon" style={iconSize("14px")} aria-hidden="true"><CircleHelp /></span>
          </span> : null}
          <button className="icon-button settings-model-close-btn" type="button" aria-label={closeLabel} disabled={busy} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="settings-data-dialog-body">{children}</div>
        <div className="settings-data-dialog-actions">{footer}</div>
      </section>
    </div>,
    document.body,
  );
}

export default function SettingsDataPanel({ demoMode = false, onOverlayOpenChange }: { demoMode?: boolean; onOverlayOpenChange?: (open: boolean) => void }) {
  const { t, locale } = useI18n();
  const [policy, setPolicy] = useState<ImagePolicy | null>(demoMode ? { mode: "block", trustedSenders: [] } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [dialog, setDialog] = useState<DataDialogId | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useDialogFocus(dialog !== null, dialogRef, { fallbackFocusRef: sectionRef });
  useEffect(() => { onOverlayOpenChange?.(dialog !== null); }, [dialog, onOverlayOpenChange]);
  useEffect(() => () => {
    if (preview) void request(`/api/app-backups/${encodeURIComponent(preview.id)}`, { method: "DELETE" }).catch(() => undefined);
  }, [preview]);
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    void request<ImagePolicy>("/api/image-policy").then((value) => { if (active) setPolicy(value); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [demoMode]);

  const closeDialog = useCallback(() => {
    if (dialog === "restore") {
      setPreview(null); setRestorePassword(""); setConfirmed(false); setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    }
    if (dialog === "export") { setPassword(""); setRepeat(""); }
    setError(""); setNotice("");
    setDialog(null);
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) closeDialog();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [busy, closeDialog, dialog]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const savePolicy = (next: ImagePolicy) => run(async () => {
    const saved = demoMode ? next : await request<ImagePolicy>("/api/image-policy", { method: "PATCH", body: JSON.stringify(next) });
    setPolicy(saved); window.dispatchEvent(new Event(IMAGE_POLICY_CHANGED));
  });

  const trusted = policy?.trustedSenders ?? [];
  const trustedSummary = !policy
    ? "—"
    : trusted.length === 0
      ? t("images.trustedNone")
      : trusted.length > 2
        ? t("images.trustedMore", { sender: trusted[0], count: trusted.length })
        : trusted.join(", ");

  const feedback = <>
    {busy && <p className="settings-empty" role="status">{t("data.working")}</p>}
    {notice && <p className="form-status success" role="status">{notice}</p>}
    {error && <p role="alert" className="form-status error">{error}</p>}
  </>;

  return <section ref={sectionRef} className="settings-section settings-data-panel" data-settings-nav="data" aria-labelledby="data-settings-title">
    <div className="settings-section-title">
      <span className="settings-data-icon" style={iconSize("18px")} aria-hidden="true"><KeyRound /></span>
      <div><span id="data-settings-title">{t("data.title")}</span></div>
    </div>

    <p className="setting-subheading"><span>{t("images.title")}</span></p>
    {policy && <label className="setting-select-row" htmlFor="image-policy-default">
      <span><strong>
        {t("images.default")}
        <span className="field-help-icon" data-tooltip={t("images.description")} aria-label={t("images.description")} tabIndex={0} onMouseDown={(event) => event.preventDefault()}>
          <span className="settings-data-icon" style={iconSize("14px")} aria-hidden="true"><CircleHelp /></span>
        </span>
      </strong></span>
      <ThemedSelect id="image-policy-default" aria-label={t("images.default")} value={policy.mode} disabled={busy} onValueChange={(value) => void savePolicy({ ...policy, mode: value as ImagePolicy["mode"] })}>
        <option value="block">{t("images.defaultBlock")}</option><option value="allow">{t("images.defaultAllow")}</option>
      </ThemedSelect>
    </label>}
    <button
      className="settings-data-entry"
      type="button"
      id="data-trusted-senders"
      aria-haspopup="dialog"
      disabled={!policy || busy}
      onClick={() => setDialog("trusted")}
    >
      <span className="settings-data-icon" aria-hidden="true"><Users /></span>
      <span className="settings-data-entry-label">{t("images.trustedTitle")}</span>
      <span className="settings-data-entry-value">{trustedSummary}</span>
      <ChevronRight className="settings-data-entry-chevron" size={14} aria-hidden="true" />
    </button>

    <p className="setting-subheading"><span>{t("data.backupTitle")}</span></p>
    <button
      className="settings-data-entry"
      type="button"
      id="data-backup-export"
      aria-haspopup="dialog"
      disabled={busy}
      onClick={() => setDialog("export")}
    >
      <span className="settings-data-icon" aria-hidden="true"><Download /></span>
      <span className="settings-data-entry-label">{t("data.exportTitle")}</span>
      <span className="settings-data-entry-value">{t("data.encryptedValue")}</span>
      <ChevronRight className="settings-data-entry-chevron" size={14} aria-hidden="true" />
    </button>

    <p className="setting-subheading"><span>{t("data.restoreTitle")}</span></p>
    <button
      className="settings-data-entry"
      type="button"
      id="data-backup-restore"
      aria-haspopup="dialog"
      disabled={busy}
      onClick={() => setDialog("restore")}
    >
      <span className="settings-data-icon" aria-hidden="true"><Upload /></span>
      <span className="settings-data-entry-label">{t("data.restoreRow")}</span>
      <span className="settings-data-entry-value">{t("data.restoreNone")}</span>
      <ChevronRight className="settings-data-entry-chevron" size={14} aria-hidden="true" />
    </button>

    {feedback}

    {dialog === "trusted" && policy && <DataDialog
      titleId="data-trusted-title"
      title={t("images.trustedTitle")}
      icon={<Users />}
      dialogRef={dialogRef}
      busy={busy}
      closeLabel={t("common.close")}
      onClose={closeDialog}
      footer={<button className="secondary-button" type="button" disabled={busy} onClick={closeDialog}>{t("common.close")}</button>}
    >
      <p className="settings-data-dialog-hint">{t("images.trustedHint")}</p>
      {trusted.length === 0
        ? <p className="settings-data-empty">{t("images.trustedNone")}</p>
        : <ul className="settings-data-trusted">{trusted.map((sender) => <li key={sender}>
          <span>{sender}</span>
          <button className="secondary-button" type="button" disabled={busy} aria-label={t("images.revokeSender", { sender })}
            onClick={() => void savePolicy({ ...policy, trustedSenders: trusted.filter((value) => value !== sender) })}>{t("images.remove")}</button>
        </li>)}</ul>}
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(async () => {
        if (!demoMode) await request("/api/image-policy/grants", { method: "DELETE" });
        window.dispatchEvent(new Event(IMAGE_POLICY_CHANGED)); setNotice(t("images.grantsCleared"));
      })}>{t("images.clearGrants")}</button>
      {feedback}
    </DataDialog>}

    {dialog === "export" && <DataDialog
      titleId="data-export-title"
      title={t("data.exportTitle")}
      icon={<Download />}
      hint={t("data.scope")}
      dialogRef={dialogRef}
      busy={busy}
      closeLabel={t("common.close")}
      onClose={closeDialog}
      footer={<>
        <button className="secondary-button" type="button" disabled={busy} onClick={closeDialog}>{t("common.cancel")}</button>
        <button className="primary-button" type="button" disabled={busy || demoMode || password.length < 12 || password !== repeat} onClick={() => void run(async () => {
          const blob = await exportApplicationBackup(password);
          const resources = new ResourceScope(); const url = ownObjectUrl(resources, blob); const anchor = document.createElement("a");
          anchor.href = url; anchor.download = `nami-mail-${new Date().toISOString().slice(0, 10)}.namibak`; anchor.click();
          window.setTimeout(() => resources.dispose(), 60_000); setNotice(t("data.exported"));
          setPassword(""); setRepeat(""); setDialog(null);
        })}>{t("data.export")}</button>
      </>}
    >
      <DataNote tone="warning">{t("data.credentialsWarning")}</DataNote>
      <DataNote tone="warning">{t("data.passwordLossWarning")}</DataNote>
      {demoMode && <DataNote>{t("data.demo")}</DataNote>}
      <label className="translation-setting-field"><span><strong>{t("data.password")}</strong></span>
        <input type="password" autoComplete="new-password" value={password} disabled={busy || demoMode} data-dialog-initial-focus onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="translation-setting-field"><span><strong>{t("data.repeatPassword")}</strong></span>
        <input type="password" autoComplete="new-password" value={repeat} disabled={busy || demoMode} onChange={(event) => setRepeat(event.target.value)} /></label>
      <p className="settings-data-dialog-hint">{t("data.passwordHint")}</p>
      <p className="settings-data-dialog-hint">{t("data.limit")}</p>
      {feedback}
    </DataDialog>}

    {dialog === "restore" && <DataDialog
      titleId="data-restore-title"
      title={t("data.restoreTitle")}
      icon={<Upload />}
      dialogRef={dialogRef}
      busy={busy}
      closeLabel={t("common.close")}
      onClose={closeDialog}
      footer={<>
        <button className="secondary-button" type="button" disabled={busy} onClick={closeDialog}>{t("common.cancel")}</button>
        {preview
          ? <button className="secondary-button danger-button" type="button" disabled={busy || !confirmed} onClick={() => void run(async () => {
            await activateApplicationBackup(preview.id);
            setPreview(null); setRestorePassword(""); setConfirmed(false); setFile(null);
            if (fileInput.current) fileInput.current.value = "";
            setDialog(null); setNotice(t("data.restartRequired"));
          })}>{t("data.activate")}</button>
          : <button className="primary-button" type="button" disabled={busy || demoMode || !file || restorePassword.length < 12} onClick={() => void run(async () => {
            if (file) { setPreview(await previewApplicationBackup(file, restorePassword)); setConfirmed(false); }
          })}>{t("data.preview")}</button>}
      </>}
    >
      <DataNote tone="warning">{t("data.restoreWarning")}</DataNote>
      {demoMode && <DataNote>{t("data.demo")}</DataNote>}
      <div className="translation-setting-field"><span><strong>{t("data.file")}</strong></span><div className="settings-data-file">
        <input ref={fileInput} className="visually-hidden" type="file" aria-label={t("data.file")} accept=".namibak" tabIndex={-1} disabled={busy || demoMode} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setConfirmed(false); }} />
        <button className="secondary-button" type="button" disabled={busy || demoMode} data-dialog-initial-focus onClick={() => fileInput.current?.click()}>{t("data.chooseFile")}</button><span>{file?.name ?? t("data.noFile")}</span>
      </div></div>
      <label className="translation-setting-field" htmlFor="restore-backup-password"><span><strong>{t("data.restorePassword")}</strong></span>
        <input id="restore-backup-password" type="password" autoComplete="current-password" value={restorePassword} disabled={busy || demoMode} onChange={(event) => { setRestorePassword(event.target.value); setPreview(null); }} /></label>
      {preview && <div className="settings-data-preview" role="region" aria-label={t("data.restorePreview")}>
        <p>{t("data.createdAt", { date: new Date(preview.createdAt).toLocaleString(locale), version: preview.schemaVersion })}</p>
        <ul>{Object.entries(preview.counts).map(([name, count]) => <li key={name}>{t(`data.count.${name}`)}: {count}</li>)}</ul>
        <label className="settings-data-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />{t("data.confirm")}</label>
      </div>}
      {feedback}
    </DataDialog>}
  </section>;
}
