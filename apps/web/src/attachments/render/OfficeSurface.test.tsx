// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_OFFICE_BLOCKS } from "../budget";
import { ResourceScope } from "../document";
import { documentWith, markup } from "../testing/surfaceHarness";
import OfficeSurface from "./OfficeSurface";

const scope = new ResourceScope();
const onDownload = () => undefined;

describe("OfficeSurface", () => {
  it("renders each paragraph as a text node", () => {
    const html = markup(
      <OfficeSurface
        document={documentWith(
          { surface: "blocks", blocks: [{ text: "first paragraph" }, { text: "second paragraph" }] },
          { kind: "office-word", filename: "notes.docx" },
        )}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html.match(/class="attachment-preview-office-block"/g)).toHaveLength(2);
    expect(html).toContain("first paragraph");
  });

  it("renders sheet rows and columns, truncated to 200 × 50", () => {
    const rows = Array.from({ length: 201 }, (_, row) => Array.from({ length: 60 }, (_, column) => `${row}:${column}`));
    const html = markup(
      <OfficeSurface
        document={documentWith(
          { surface: "sheet", sheets: [{ name: "Sheet1", rows }] },
          { kind: "office-sheet", filename: "book.xlsx" },
        )}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html.match(/<tr>/g)).toHaveLength(200);
    expect(html).toContain("0:49");
    expect(html).not.toContain("0:50");
    expect(html).toContain("Sheet1");
  });

  it("refuses more blocks than the ceiling allows", () => {
    const blocks = Array.from({ length: MAX_OFFICE_BLOCKS + 1 }, (_, index) => ({ text: `block ${index}` }));
    expect(() =>
      markup(
        <OfficeSurface
          document={documentWith({ surface: "blocks", blocks }, { kind: "office-word" })}
          scope={scope}
          onDownload={onDownload}
        />,
      ),
    ).toThrow(/ceiling/);
  });

  it("never turns block text into markup", () => {
    const html = markup(
      <OfficeSurface
        document={documentWith({ surface: "blocks", blocks: [{ text: "<script>alert(1)</script>" }] }, { kind: "office-word" })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
