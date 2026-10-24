import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentFileIcon } from "./mailUi";

describe("AttachmentFileIcon", () => {
  it("renders the extension's own file icon, not a generic document glyph", () => {
    const xlsx = renderToStaticMarkup(<AttachmentFileIcon kind="spreadsheet" filename="budget.xlsx" />);
    expect(xlsx).toContain(">xlsx</text>");
    expect(xlsx).toContain('fill="#1A754C"');

    const pptx = renderToStaticMarkup(<AttachmentFileIcon kind="document" filename="deck.pptx" />);
    expect(pptx).toContain(">pptx</text>");
    expect(pptx).toContain('fill="#D14423"');

    const pdf = renderToStaticMarkup(<AttachmentFileIcon kind="pdf" filename="report.pdf" />);
    expect(pdf).toContain(">pdf</text>");
    expect(pdf).toContain('fill="#D93831"');
  });

  it("falls back to the kind's icon for extensions the set does not know", () => {
    const tsx = renderToStaticMarkup(<AttachmentFileIcon kind="code" filename="App.tsx" />);
    expect(tsx).toContain(">tsx</text>");
    expect(tsx).toContain('fill="#2563EB"');

    const unknown = renderToStaticMarkup(<AttachmentFileIcon kind="text" filename="scan.foo" />);
    expect(unknown).toContain(">foo</text>");
    expect(unknown).toContain('fill="#475569"');
  });

  it("draws a page icon even when the filename has no extension", () => {
    const markup = renderToStaticMarkup(<AttachmentFileIcon kind="other" filename="README" />);
    expect(markup).toContain("attachment-file-icon kind-other");
    expect(markup).toContain("<svg");
  });
});
