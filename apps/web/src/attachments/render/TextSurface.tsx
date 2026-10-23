import { useI18n } from "../../i18n";
import CopyButton from "../../CopyButton";
import type { SurfaceProps } from "../document";

/**
 * Text and code: a `<pre>` with the retained prefix and nothing parsed.
 *
 * The element is a text node by construction — there is no path here that could
 * turn a `<script>` inside an attachment into markup.
 */
export default function TextSurface({ document }: SurfaceProps) {
  const { t } = useI18n();
  const surface = document.surface;
  if (surface.surface !== "text" && surface.surface !== "markdown") return null;
  const truncated = surface.shown < surface.total;
  return (
    <div className="attachment-preview-text-wrap">
      <pre className="attachment-preview-text" tabIndex={0}>
        {surface.text}
      </pre>
      <div className="attachment-preview-text-footer">
        <CopyButton
          text={surface.text}
          ariaLabel={t("mail.attachment.previewTitle")}
          className="attachment-preview-copy"
        />
        {truncated && (
          <p className="attachment-preview-truncated">
            {t("mail.attachment.previewTruncated", { count: surface.shown, total: surface.total })}
          </p>
        )}
      </div>
    </div>
  );
}
