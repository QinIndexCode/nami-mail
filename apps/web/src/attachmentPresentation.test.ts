import { describe, expect, it } from "vitest";
import { presentAttachment } from "./attachmentPresentation";

describe("attachment presentation", () => {
  it.each([
    ["review.pdf", "application/octet-stream", { kind: "pdf", label: "PDF" }],
    ["photo.png", "image/png", { kind: "image", label: "图片" }],
    ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { kind: "spreadsheet", label: "表格" }],
    ["sources.zip", "application/zip", { kind: "archive", label: "压缩文件" }],
    ["notes.txt", "text/plain", { kind: "document", label: "文本" }],
    ["signed.payload", "application/octet-stream", { kind: "other", label: "文件" }],
  ])("presents %s as a friendly file type", (filename, contentType, expected) => {
    expect(presentAttachment(filename, contentType)).toEqual(expected);
  });
});
