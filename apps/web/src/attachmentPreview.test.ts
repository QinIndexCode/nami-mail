import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentPreviewKind,
  canPreviewAttachment,
  extractAttachmentPreviewText,
  maxPreviewTextChars,
  type AttachmentPreviewKind,
} from "./attachmentPreview";

vi.mock("mammoth/mammoth.browser", () => ({
  extractRawText: vi.fn(async () => ({ value: "Word 文档正文" })),
}));

describe("attachmentPreviewKind", () => {
  it.each<[string, string, AttachmentPreviewKind]>([
    ["report.pdf", "application/pdf", "pdf"],
    ["report.PDF", "application/octet-stream", "pdf"],
    ["scan", "application/pdf", "pdf"],
    ["photo.png", "image/png", "image"],
    ["photo.jpg", "image/jpeg", "image"],
    ["animation.GIF", "application/octet-stream", "image"],
    ["notes.txt", "text/plain", "text"],
    ["README.md", "application/octet-stream", "text"],
    ["data.csv", "text/csv", "text"],
    ["config", "text/yaml", "text"],
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office"],
    ["deck.pptx", "application/octet-stream", "office"],
    ["sheet.xlsx", "application/octet-stream", "office"],
    ["bundle.zip", "application/zip", "unsupported"],
    ["setup.exe", "application/octet-stream", "unsupported"],
  ])("classifies %s (%s) as %s", (filename, contentType, expected) => {
    expect(attachmentPreviewKind(filename, contentType)).toBe(expected);
  });

  it("exposes canPreviewAttachment as the complement of unsupported", () => {
    expect(canPreviewAttachment("report.pdf", "application/pdf")).toBe(true);
    expect(canPreviewAttachment("letter.docx", "application/octet-stream")).toBe(true);
    expect(canPreviewAttachment("bundle.zip", "application/zip")).toBe(false);
  });
});

describe("extractAttachmentPreviewText", () => {
  it("reads plain text files", async () => {
    const blob = new Blob(["第一行\nsecond line"], { type: "text/plain" });
    const result = await extractAttachmentPreviewText(blob, "notes.txt");
    expect(result.text).toBe("第一行\nsecond line");
    expect(result.truncated).toBe(false);
  });

  it("truncates oversized text and reports it", async () => {
    const blob = new Blob([`${"字".repeat(maxPreviewTextChars)}尾部`], { type: "text/plain" });
    const result = await extractAttachmentPreviewText(blob, "big.txt");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(maxPreviewTextChars);
    expect(result.text.endsWith("尾部")).toBe(false);
  });

  it("extracts cell text from a minimal xlsx workbook", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/sharedStrings.xml",
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>姓名</t></si><si><t>Alice</t></si><si><t>100</t></si></sst>',
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>行二</t></is></c><c r="B2"><v>42</v></c></row>'
      + "</sheetData></worksheet>",
    );
    const result = await extractAttachmentPreviewText(await zip.generateAsync({ type: "blob" }), "book.xlsx");
    expect(result.text).toBe("姓名\tAlice\n行二\t42");
  });

  it("extracts slide text from a minimal pptx deck in slide order", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
    zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>第一页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
    const result = await extractAttachmentPreviewText(await zip.generateAsync({ type: "blob" }), "deck.pptx");
    expect(result.text).toBe("第一页\n\n第二页");
  });

  it("extracts docx text through mammoth", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" });

    const result = await extractAttachmentPreviewText(blob, "letter.docx");
    expect(result.text).toBe("Word 文档正文");
  });
});
