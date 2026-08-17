import { FileText, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  attachmentPreviewKind,
  extractAttachmentPreviewText,
  maxAttachmentPreviewBytes,
  maxPreviewTextChars,
  type AttachmentPreviewKind,
} from "./attachmentPreview";
import { mailErrorMessage } from "./errorPresentation";
import { useI18n } from "./i18n";
import { useDismissTransition } from "./useDismissTransition";

export type PreviewAttachment = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
};

type AttachmentPreviewModalProps = {
  messageId: string;
  attachment: PreviewAttachment | null;
  onClose: () => void;
  /** Test seam: override the blob fetcher used to load the attachment. */
  fetchBlob?: (messageId: string, partId: string) => Promise<Blob>;
};

type PreviewPhase = "loading" | "ready" | "error";

const tooLargeMarker = "__too-large__";

export default function AttachmentPreviewModal({
  messageId,
  attachment,
  onClose,
  fetchBlob,
}: AttachmentPreviewModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const kind: AttachmentPreviewKind | null = useMemo(
    () => (attachment ? attachmentPreviewKind(attachment.filename, attachment.contentType) : null),
    [attachment],
  );

  const fetch = useMemo(() => fetchBlob ?? api.downloadAttachment, [fetchBlob]);

  useEffect(() => {
    if (!attachment || !kind || kind === "unsupported") return undefined;
    let active = true;
    setPhase("loading");
    setText(null);
    setErrorDetail(null);
    void fetch(messageId, attachment.partId).then(async (blob) => {
      if (!active) return;
      if (kind === "pdf" || kind === "image") {
        objectUrlRef.current = URL.createObjectURL(blob);
        setPhase("ready");
        return;
      }
      if (blob.size > maxAttachmentPreviewBytes) {
        setErrorDetail(tooLargeMarker);
        setPhase("error");
        return;
      }
      const extracted = await extractAttachmentPreviewText(blob, attachment.filename);
      if (!active) return;
      setText(extracted);
      setPhase("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setErrorDetail(mailErrorMessage(error, t("mail.attachment.previewFailed"), t));
      setPhase("error");
    });
    return () => {
      active = false;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [attachment, kind, messageId, fetch, t]);

  // The preview is a non-modal in-flow pane next to the message (a Gmail-style
  // reading pane), so focus simply lands on the drawer itself and the reader
  // stays interactive; no trap is installed.
  useEffect(() => {
    if (!attachment) return undefined;
    dialogRef.current?.focus();
    return undefined;
  }, [attachment]);

  const { closing, requestClose } = useDismissTransition(() => {
    onClose();
  }, 260);

  useEffect(() => {
    if (!attachment) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [attachment, requestClose]);

  if (!attachment) return null;

  const objectUrl = objectUrlRef.current;

  return (
    <section ref={dialogRef} className={`attachment-preview-drawer${closing ? " closing" : ""}`} role="dialog" aria-modal="false" aria-labelledby="attachment-preview-title" tabIndex={-1}>
        <header className="modal-heading attachment-preview-heading">
          <div className="attachment-preview-title-copy">
            <h2 id="attachment-preview-title">{t("mail.attachment.previewTitle")}</h2>
            <small className="truncated-tooltip" data-tooltip={attachment.filename}><span>{attachment.filename}</span></small>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.close")} data-tooltip={t("common.close")} onClick={requestClose}>
            <X size={18} />
          </button>
        </header>
        <div className="attachment-preview-body">
          {kind === "unsupported" ? (
            <div className="attachment-preview-unsupported" role="status">
              <FileText size={30} aria-hidden="true" />
              <p>{t("mail.attachment.previewUnsupported")}</p>
            </div>
          ) : phase === "loading" ? (
            <div className="attachment-preview-loading" role="status">
              <LoaderCircle className="spin" size={20} aria-hidden="true" />
              <span>{t("mail.attachment.previewLoading")}</span>
            </div>
          ) : phase === "error" ? (
            <div className="attachment-preview-error" role="alert">
              <p>{errorDetail === tooLargeMarker ? t("mail.attachment.previewTooLarge") : errorDetail ?? t("mail.attachment.previewFailed")}</p>
            </div>
          ) : kind === "pdf" ? (
            <iframe className="attachment-preview-frame" title={attachment.filename} src={objectUrl ?? undefined} />
          ) : kind === "image" ? (
            <img className="attachment-preview-image" src={objectUrl ?? undefined} alt={attachment.filename} />
          ) : (
            <div className="attachment-preview-text-wrap">
              <pre className="attachment-preview-text">{text?.text ?? ""}</pre>
              {text?.truncated && (
                <p className="attachment-preview-truncated">{t("mail.attachment.previewTruncated", { count: String(maxPreviewTextChars) })}</p>
              )}
            </div>
          )}
        </div>
      </section>
  );
}
