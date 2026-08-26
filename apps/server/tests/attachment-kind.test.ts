import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_KINDS,
  attachmentKindsJson,
  classifyAttachmentKind,
} from "../src/attachment-kind.js";

describe("classifyAttachmentKind", () => {
  it("classifies by extension first, case-insensitively", () => {
    expect(classifyAttachmentKind("report.pdf", "application/octet-stream")).toBe("pdf");
    expect(classifyAttachmentKind("photo.JPG", "application/octet-stream")).toBe("image");
    expect(classifyAttachmentKind("archive.ZIP", "application/octet-stream")).toBe("archive");
    expect(classifyAttachmentKind("notes.DOCX", "application/octet-stream")).toBe("document");
    expect(classifyAttachmentKind("song.MP3", "application/octet-stream")).toBe("media");
    expect(classifyAttachmentKind("budget.XLSX", "application/octet-stream")).toBe("spreadsheet");
  });

  it("falls back to the MIME type when the extension is unknown", () => {
    expect(classifyAttachmentKind("payload", "application/pdf")).toBe("pdf");
    expect(classifyAttachmentKind("blob", "image/png")).toBe("image");
    expect(classifyAttachmentKind("clip", "video/mp4")).toBe("media");
    expect(classifyAttachmentKind("bundle", "audio/ogg")).toBe("media");
    expect(classifyAttachmentKind("sheet", "application/vnd.ms-excel")).toBe("spreadsheet");
    expect(classifyAttachmentKind("letter", "application/msword")).toBe("document");
    expect(classifyAttachmentKind("slides", "application/vnd.ms-powerpoint")).toBe("document");
    expect(classifyAttachmentKind("package", "application/x-zip-compressed")).toBe("archive");
    expect(classifyAttachmentKind("data", "text/json")).toBe("code");
    expect(classifyAttachmentKind("script", "text/javascript")).toBe("code");
  });

  it("tags programming and config source files as code", () => {
    for (const extension of ["ts", "tsx", "jsx", "rs", "go", "py", "sh", "json", "yaml", "sql", "css"]) {
      expect(classifyAttachmentKind(`snippet.${extension}`, "application/octet-stream")).toBe("code");
    }
  });

  it("treats plain text as text", () => {
    expect(classifyAttachmentKind("notes.txt", "application/octet-stream")).toBe("text");
    expect(classifyAttachmentKind("notes", "text/plain")).toBe("text");
  });

  it("maps anything unrecognized to other", () => {
    expect(classifyAttachmentKind("mystery.xyz", "application/octet-stream")).toBe("other");
    expect(classifyAttachmentKind("weird", "application/x-custom-format")).toBe("other");
    expect(classifyAttachmentKind("", "")).toBe("other");
  });

  it("an extension beats a contradictory MIME type", () => {
    expect(classifyAttachmentKind("photo.png", "text/plain")).toBe("image");
    expect(classifyAttachmentKind("archive.zip", "image/gif")).toBe("archive");
  });
});

describe("attachmentKindsJson", () => {
  it("serializes the distinct kinds of a message's attachments", () => {
    expect(attachmentKindsJson([
      { filename: "report.pdf", contentType: "application/pdf" },
      { filename: "logo.png", contentType: "image/png" },
      { filename: "report.pdf", contentType: "application/pdf" },
    ])).toBe('["pdf","image"]');
  });

  it("returns an empty array for messages without attachments", () => {
    expect(attachmentKindsJson([])).toBe("[]");
  });

  it("deduplicates kinds regardless of attachment order", () => {
    // The JSON keeps first-occurrence order; assert the member sets.
    const first = JSON.parse(attachmentKindsJson([
      { filename: "a.zip", contentType: "application/zip" },
      { filename: "b.pdf", contentType: "application/pdf" },
    ])) as string[];
    const second = JSON.parse(attachmentKindsJson([
      { filename: "b.pdf", contentType: "application/pdf" },
      { filename: "a.zip", contentType: "application/zip" },
    ])) as string[];
    expect([...first].sort()).toEqual([...second].sort());
  });
});

describe("ATTACHMENT_KINDS", () => {
  it("covers every kind the classifier can produce", () => {
    const sample = [
      "report.zip", "snippet.ts", "letter.docx", "photo.jpg", "song.mp4",
      "paper.pdf", "budget.xlsx", "notes.txt", "artifact.iso",
    ];
    for (const filename of sample) {
      expect(ATTACHMENT_KINDS).toContain(classifyAttachmentKind(filename, "application/octet-stream"));
    }
  });
});