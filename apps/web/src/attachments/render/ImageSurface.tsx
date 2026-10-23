import { Download } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";
import type { SurfaceProps } from "../document";

/**
 * Raster and vector share one implementation: the browser decodes the blob URL,
 * so the only work is the intrinsic size and the alt text.
 *
 * A decode failure is reported in place — the drawer's state belongs to the
 * document, and an image the browser refuses is a property of this one surface,
 * not a new top-level failure.
 */
export default function ImageSurface({ document, onDownload }: SurfaceProps) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const surface = document.surface;
  if (surface.surface !== "raster" && surface.surface !== "vector") return null;
  const alt = surface.surface === "raster" ? surface.alt : document.filename;
  if (failed) {
    return (
      <div className="attachment-preview-image-failed">
        <p>{t("mail.attachment.previewCorrupt")}</p>
        <button type="button" className="attachment-preview-download" onClick={onDownload}>
          <Download size={14} aria-hidden="true" />
          {t("mail.attachment.previewDownloadOnly")}
        </button>
      </div>
    );
  }
  return (
    <div className="attachment-preview-image-wrap attachment-preview-scroll" data-surface={surface.surface}>
      <img
        className="attachment-preview-image"
        src={surface.url}
        width={surface.width}
        height={surface.height}
        alt={alt}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
