import { describe, expect, it } from "vitest";
import { presentAttachment } from "./attachmentPresentation";
import { translate } from "./i18n";

const zh = (key: string) => translate("zh-CN", key);

describe("attachment presentation", () => {
  it.each([
    ["review.pdf", "application/octet-stream", { kind: "pdf", label: zh("attachment.pdf") }],
    ["photo.png", "image/png", { kind: "image", label: zh("attachment.image") }],
    ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { kind: "spreadsheet", label: zh("attachment.spreadsheet") }],
    ["sources.zip", "application/zip", { kind: "archive", label: zh("attachment.archive") }],
    ["notes.txt", "text/plain", { kind: "text", label: zh("attachment.text") }],
    ["signed.payload", "application/octet-stream", { kind: "other", label: zh("attachment.file") }],
  ])("presents %s as a friendly file type", (filename, contentType, expected) => {
    expect(presentAttachment(filename, contentType)).toEqual(expected);
  });
});
