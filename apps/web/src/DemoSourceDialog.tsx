import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { IconButton } from "./mailUi";
import { MailTextBody } from "./MailTextBody";
import { SenderAvatar, accountTone } from "./SenderAvatar";
import type { Message } from "./types";

/** A source stays inside the website's assistant demo, using the client reader's typography. */
export default function DemoSourceDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const { t, formatDate } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(true, dialogRef, { preventScroll: true });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="modal-card demo-source-card" role="dialog" aria-modal="true" aria-labelledby="demo-source-title" tabIndex={-1} style={{ width: "min(680px, 100%)" }}>
      <header style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", gap: 16 }}>
        <div className="modal-card-header"><p className="eyebrow">{t("agent.citations.title")}</p><h3 id="demo-source-title">{message.subject || t("agent.reference.noSubject")}</h3></div>
        <IconButton label={t("common.close")} onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="mail-people">
        <SenderAvatar name={message.from.name ?? ""} address={message.from.address} tone={accountTone(message.from.address)} gravatarEnabled={false} bimiEnabled={false} />
        <div className="mail-people-copy"><strong>{message.from.name || message.from.address}</strong><span style={{ color: "var(--text-faint)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message.from.address}</span></div>
        <time dateTime={message.sentAt}>{formatDate(message.sentAt)}</time>
      </div>
      <div className="mail-content" style={{ padding: "24px 0 0", minHeight: 0 }}><div className="mail-text"><MailTextBody body={message.textBody || message.snippet} /></div></div>
    </section>
  </div>;
}
