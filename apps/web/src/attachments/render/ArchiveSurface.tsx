import { useI18n } from "../../i18n";
import { formatFileSize } from "../../mailUi";
import { escapesArchiveRoot } from "../zip/reader";
import type { SurfaceProps } from "../document";

/**
 * Archive surface (plan §4.4): a listing, never an extraction.
 *
 * There is no "open entry" affordance because there is nothing behind one — the
 * decoder did not inflate a single byte. Paths that try to escape the archive
 * root (`../x`, `a/../../x`) are dropped here rather than shown, so the DOM
 * never carries a path that a future "extract" feature could reuse blindly.
 */
export default function ArchiveSurface({ document }: SurfaceProps) {
  const { t } = useI18n();
  const surface = document.surface;
  if (surface.surface !== "archive") return null;
  const visible = surface.entries.filter((entry) => !escapesArchiveRoot(entry.path));
  return (
    <div className="attachment-preview-archive">
      <p className="attachment-preview-archive-summary">
        {t("mail.attachment.previewArchiveCount", {
          count: surface.entries.length,
          size: formatFileSize(surface.declaredBytes),
        })}
      </p>
      <p className="attachment-preview-archive-note">{t("mail.attachment.previewArchiveNoExtract")}</p>
      <ul className="attachment-preview-archive-list">
        {visible.map((entry, index) => (
          <li key={index}>
            <span className="attachment-preview-archive-path">{entry.path}</span>
            <span className="attachment-preview-archive-size">{formatFileSize(entry.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
