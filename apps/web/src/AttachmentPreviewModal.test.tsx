import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AttachmentPreviewModal from "./AttachmentPreviewModal";
import { I18nProvider, translate } from "./i18n";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

function renderModal(attachment: { partId: string; filename: string; contentType: string; size: number } | null): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AttachmentPreviewModal messageId="message-1" attachment={attachment} onClose={() => undefined} />
    </I18nProvider>,
  );
}

describe("attachment preview modal", () => {
  it("renders nothing without an attachment", () => {
    expect(renderModal(null)).toBe("");
  });

  it("shows the title, filename and a loading state for a previewable file", () => {
    const markup = renderModal({ partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 });

    expect(markup).toContain('id="attachment-preview-title"');
    expect(markup).toContain(zh("mail.attachment.previewTitle"));
    expect(markup).toContain("report.pdf");
    expect(markup).toContain(zh("mail.attachment.previewLoading"));
    expect(markup).not.toContain(zh("mail.attachment.previewUnsupported"));
  });

  it("renders as an in-flow drawer keeping the dialog semantics", () => {
    const markup = renderModal({ partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 });

    expect(markup).toContain("attachment-preview-drawer");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("aria-modal=\"false\"");
    // The pane sits next to the message; no backdrop overlay is rendered.
    expect(markup).not.toContain("backdrop");
  });

  it("declines unsupported file types without fetching", () => {
    const markup = renderModal({ partId: "part-2", filename: "bundle.zip", contentType: "application/zip", size: 1024 });

    expect(markup).toContain(zh("mail.attachment.previewUnsupported"));
    expect(markup).not.toContain(zh("mail.attachment.previewLoading"));
  });
});
