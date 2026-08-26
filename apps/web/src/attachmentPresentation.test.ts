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
    ["train.py", "text/x-python", { kind: "code", label: zh("attachment.code") }],
    ["main.go", "application/octet-stream", { kind: "code", label: zh("attachment.code") }],
    ["config.json", "application/json", { kind: "code", label: zh("attachment.code") }],
    ["podcast.mp3", "audio/mpeg", { kind: "media", label: zh("attachment.media") }],
    ["clip.mov", "application/octet-stream", { kind: "media", label: zh("attachment.media") }],
    ["deck.key", "application/octet-stream", { kind: "document", label: zh("attachment.document") }],
    ["fonts.ttf", "application/octet-stream", { kind: "other", label: "TTF" }],
  ])("presents %s as a friendly file type", (filename, contentType, expected) => {
    expect(presentAttachment(filename, contentType)).toEqual(expected);
  });
});
