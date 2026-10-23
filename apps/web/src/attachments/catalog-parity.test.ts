import { describe, expect, it } from "vitest";
import * as contract from "@nami/agent-contracts";
import {
  ATTACHMENT_KINDS as serverAttachmentKinds,
  attachmentKindsJson as serverAttachmentKindsJson,
  classifyAttachmentKind as serverClassifyAttachmentKind,
  codeTextExtensions as serverCodeTextExtensions,
} from "../../../server/src/attachment-kind";
import {
  attachmentKinds,
  canOpenPreview,
  classifyAttachmentKind,
  codeTextExtensions,
  extensionKinds,
  mediaKind,
  previewKindFor,
  surfaceFor,
  type AttachmentKind,
  type AttachmentMetadata,
  type PreviewKind,
} from "./catalog";

/**
 * Preview expectations derived from the contract kind plus the curated text
 * sets — an independent recomputation, not a call into `previewKindFor`, so a
 * drifted derivation fails here instead of agreeing with itself.
 */
function expectedPreviewKind(extension: string): PreviewKind {
  const kind: AttachmentKind | undefined = extensionKinds[extension];
  if (contract.markdownExtensions.has(extension)) return "markdown";
  if (contract.plainTextExtensions.has(extension)) return "text";
  if (codeTextExtensions.has(extension)) return "code";
  switch (kind) {
    case "pdf":
      return "pdf";
    case "image":
      return extension === "svg" ? "image-vector" : "image-raster";
    case "media": {
      const family = mediaKind(`file.${extension}`);
      if (family === "audio") return "media-audio";
      if (family === "video") return "media-video";
      return "fallback";
    }
    case "document":
      return extension === "docx" ? "office-word" : extension === "pptx" ? "office-slides" : "fallback";
    case "spreadsheet":
      return extension === "xlsx" ? "office-sheet" : "fallback";
    case "archive":
      return extension === "zip" ? "archive" : "fallback";
    case "text":
      return "text";
    case "code":
      return "code";
    case "other":
    case undefined:
      return "fallback";
  }
}

describe("web derivation vs the contract table", () => {
  it("derives one preview kind per catalog extension, matching the curated sets", () => {
    for (const extension of Object.keys(extensionKinds)) {
      const metadata: AttachmentMetadata = { filename: `file.${extension}`, contentType: "" };
      expect(previewKindFor(metadata), extension).toBe(expectedPreviewKind(extension));
      expect(surfaceFor(previewKindFor(metadata))).toBeTruthy();
    }
  });

  it("classifies exactly like the contract for every extension", () => {
    for (const extension of Object.keys(extensionKinds)) {
      expect(classifyAttachmentKind(`file.${extension}`, ""), extension).toBe(extensionKinds[extension]);
    }
  });

  it("keeps the kind vocabulary and text sets by identity", () => {
    expect(attachmentKinds).toBe(contract.attachmentKinds);
    expect(codeTextExtensions).toBe(contract.codeTextExtensions);
  });
});

/**
 * Cases migrated from the retired `attachmentPreview.test.ts`: same files and
 * stored MIME types, assertions rewritten to the new renderer vocabulary.
 */
const migratedCases: [string, string, PreviewKind][] = [
  ["report.pdf", "application/pdf", "pdf"],
  ["report.PDF", "application/octet-stream", "pdf"],
  ["scan", "application/pdf", "pdf"],
  ["photo.png", "image/png", "image-raster"],
  ["photo.jpg", "image/jpeg", "image-raster"],
  ["animation.GIF", "application/octet-stream", "image-raster"],
  ["notes.txt", "text/plain", "text"],
  ["README.md", "application/octet-stream", "markdown"],
  ["data.csv", "text/csv", "text"],
  // YAML with no extension was "text" under the old five-value vocabulary;
  // the contract treats YAML as source-like, so it now renders as code.
  ["config", "text/yaml", "code"],
  ["main.py", "text/x-python", "code"],
  ["App.tsx", "text/plain", "code"],
  ["worker.rs", "application/octet-stream", "code"],
  ["photo.avif", "image/avif", "image-raster"],
  ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office-word"],
  ["deck.pptx", "application/octet-stream", "office-slides"],
  ["sheet.xlsx", "application/octet-stream", "office-sheet"],
  ["bundle.zip", "application/zip", "archive"],
  ["setup.exe", "application/octet-stream", "fallback"],
];

describe("migrated attachment preview classification", () => {
  it.each(migratedCases)("classifies %s (%s) as %s", (filename, contentType, expected) => {
    expect(previewKindFor({ filename, contentType })).toBe(expected);
  });

  it("opens every migrated case, including the ones the old gate refused", () => {
    for (const [filename, contentType] of migratedCases) {
      expect(canOpenPreview(previewKindFor({ filename, contentType })), filename).toBe(true);
    }
  });
});

describe("server forwarder vs the contract", () => {
  // The three media extensions added by this slice; the other 135 are the
  // pre-existing vocabulary, i.e. the snapshot the server used to own.
  const addedMediaExtensions = new Set(["mpeg", "mpg", "ogv"]);

  it("keeps the 135-extension legacy snapshot classifying identically", () => {
    const legacySnapshot = Object.keys(extensionKinds).filter((extension) => !addedMediaExtensions.has(extension));
    expect(legacySnapshot).toHaveLength(135);
    for (const extension of legacySnapshot) {
      const filename = `file.${extension}`;
      expect(serverClassifyAttachmentKind(filename, ""), extension).toBe(extensionKinds[extension]);
      expect(serverClassifyAttachmentKind(filename, ""), extension).toBe(contract.classifyAttachmentKind(filename, ""));
    }
  });

  it("classifies the three added media extensions as media", () => {
    for (const extension of addedMediaExtensions) {
      expect(serverClassifyAttachmentKind(`file.${extension}`, "")).toBe("media");
      expect(previewKindFor({ filename: `file.${extension}`, contentType: "" })).not.toBe("fallback");
    }
  });

  it("re-exports the contract objects instead of copies", () => {
    expect(serverAttachmentKinds).toBe(contract.attachmentKinds);
    expect(serverCodeTextExtensions).toBe(contract.codeTextExtensions);
  });

  it("serializes the same attachment-kind column value as the contract", () => {
    const samples = [
      [{ filename: "report.pdf", contentType: "" }, { filename: "photo.png", contentType: "" }],
      [{ filename: "bundle.zip", contentType: "" }, { filename: "main.py", contentType: "" }],
      [],
    ];
    for (const sample of samples) {
      expect(serverAttachmentKindsJson(sample)).toBe(contract.attachmentKindsJson(sample));
    }
  });
});
