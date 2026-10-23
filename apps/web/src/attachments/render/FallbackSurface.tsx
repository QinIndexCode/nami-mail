import { Download } from "lucide-react";
import { useI18n } from "../../i18n";
import { sanitizeDisplayName } from "../catalog";
import { downloadOnlyMessageKey, type SurfaceProps } from "../document";

/**
 * The download card: one primary line plus, for two of the four reasons, one
 * secondary line that says *why*.
 *
 * `size` and `encrypted` only get the primary line — the title already reports
 * the size, and an encrypted file explains itself. `unsupported` and `mime` are
 * different failures and must not share a sentence: one means "no decoder",
 * the other means "the bytes disagree with the extension".
 */
export default function FallbackSurface({ document, onDownload }: SurfaceProps) {
  const { t } = useI18n();
  const surface = document.surface;
  const reason = surface.surface === "download_only" ? surface.reason : "unsupported";
  const primaryKey = surface.surface === "download_only" ? surface.messageKey : downloadOnlyMessageKey;
  return (
    <div className="attachment-preview-download-only">
      <p>{t(primaryKey)}</p>
      {reason === "unsupported" && <p className="attachment-preview-download-reason">{t("mail.attachment.previewUnsupported")}</p>}
      {reason === "mime" && <p className="attachment-preview-download-reason">{t("mail.attachment.previewKindMismatch")}</p>}
      <button type="button" className="attachment-preview-download" onClick={onDownload}>
        <Download size={14} aria-hidden="true" />
        {t("mail.attachment.download", { filename: sanitizeDisplayName(document.filename) })}
      </button>
    </div>
  );
}
