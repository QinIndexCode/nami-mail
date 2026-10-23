import { describe, expect, it } from "vitest";
import * as contract from "@nami/agent-contracts";
import {
  attachmentKinds,
  canOpenPreview,
  codeTextExtensions,
  extensionKinds,
  mediaKind,
  previewKindFor,
  previewKinds,
  previewSurfaceNames,
  sanitizeDisplayName,
  sniffSignature,
  surfaceFor,
  tierFor,
  type AttachmentMetadata,
  type PreviewKind,
  type PreviewSurfaceName,
  type PreviewTier,
} from "./catalog";

/** One attachment per preview kind, used to prove every kind is reachable. */
const representatives: Record<PreviewKind, AttachmentMetadata> = {
  pdf: { filename: "report.pdf", contentType: "" },
  "image-raster": { filename: "photo.png", contentType: "" },
  "image-vector": { filename: "logo.svg", contentType: "" },
  text: { filename: "notes.txt", contentType: "" },
  code: { filename: "main.py", contentType: "" },
  markdown: { filename: "README.md", contentType: "" },
  "office-word": { filename: "letter.docx", contentType: "" },
  "office-sheet": { filename: "sheet.xlsx", contentType: "" },
  "office-slides": { filename: "deck.pptx", contentType: "" },
  archive: { filename: "bundle.zip", contentType: "" },
  "media-audio": { filename: "podcast.mp3", contentType: "" },
  "media-video": { filename: "clip.mp4", contentType: "" },
  fallback: { filename: "setup.exe", contentType: "" },
};

const expectedSurfaces: Record<PreviewKind, PreviewSurfaceName> = {
  pdf: "pdf",
  "image-raster": "raster",
  "image-vector": "vector",
  text: "text",
  code: "text",
  markdown: "markdown",
  "office-word": "blocks",
  "office-sheet": "sheet",
  "office-slides": "blocks",
  archive: "archive",
  "media-audio": "media",
  "media-video": "media",
  fallback: "download_only",
};

const expectedTiers: Record<PreviewKind, PreviewTier> = {
  pdf: "A",
  "image-raster": "A",
  "image-vector": "A",
  text: "A",
  code: "A",
  markdown: "A",
  "office-word": "A",
  "office-sheet": "A",
  "office-slides": "A",
  archive: "B",
  "media-audio": "A",
  "media-video": "A",
  fallback: "C",
};

describe("attachment preview kind derivation", () => {
  it("has thirteen preview kinds and ten surfaces, each used by the table", () => {
    expect(previewKinds).toHaveLength(13);
    expect(new Set(previewKinds).size).toBe(13);
    expect(previewSurfaceNames).toHaveLength(10);
    expect(new Set(previewSurfaceNames).size).toBe(10);
    expect(new Set(previewKinds.map((kind) => surfaceFor(kind))).size).toBe(previewSurfaceNames.length);
  });

  it("derives each preview kind from a real attachment", () => {
    for (const kind of previewKinds) {
      expect(previewKindFor(representatives[kind])).toBe(kind);
    }
  });

  it("keeps the kind vocabulary identical to the contract", () => {
    // Identity, not equality: this module re-exports the contract objects
    // rather than keeping a second copy that can drift.
    expect(attachmentKinds).toBe(contract.attachmentKinds);
    expect(codeTextExtensions).toBe(contract.codeTextExtensions);
    expect(extensionKinds).toBe(contract.extensionKinds);
    expect(sniffSignature).toBe(contract.sniffSignature);
  });

  it("maps every catalog extension to exactly one preview kind and surface", () => {
    const derived = new Map<string, PreviewKind>();
    for (const extension of Object.keys(extensionKinds)) {
      const previewKind = previewKindFor({ filename: `file.${extension}`, contentType: "" });
      expect(previewKinds).toContain(previewKind);
      expect(previewSurfaceNames).toContain(surfaceFor(previewKind));
      derived.set(extension, previewKind);
    }
    // One entry per extension: nothing is classified twice, nothing is missing.
    expect(derived.size).toBe(Object.keys(extensionKinds).length);
  });

  it("shows spreadsheet-kind files as text but keeps the spreadsheet kind", () => {
    // Two axes on purpose: `.csv` is a spreadsheet for filtering and text for
    // rendering; merging the lists would force a wrong answer on one axis.
    expect(contract.classifyAttachmentKind("data.csv", "")).toBe("spreadsheet");
    expect(previewKindFor({ filename: "data.csv", contentType: "text/csv" })).toBe("text");
    expect(previewKindFor({ filename: "data.tsv", contentType: "" })).toBe("text");
    expect(previewKindFor({ filename: "notes.log", contentType: "" })).toBe("text");
    expect(previewKindFor({ filename: "draft.mdx", contentType: "" })).toBe("markdown");
  });

  it("shows only the document flavours this slice can decode", () => {
    for (const filename of ["letter.docx", "letter.DOCX"]) {
      expect(previewKindFor({ filename, contentType: "" })).toBe("office-word");
    }
    expect(previewKindFor({ filename: "deck.pptx", contentType: "" })).toBe("office-slides");
    expect(previewKindFor({ filename: "sheet.xlsx", contentType: "" })).toBe("office-sheet");
    // Legacy/foreign document formats have no parser here: download only.
    for (const filename of ["letter.doc", "deck.ppt", "sheet.xls", "letter.rtf", "letter.pages"]) {
      expect(previewKindFor({ filename, contentType: "" })).toBe("fallback");
    }
  });

  it("treats only zip archives as listable and media as audio or video", () => {
    expect(previewKindFor({ filename: "bundle.zip", contentType: "" })).toBe("archive");
    for (const filename of ["bundle.7z", "bundle.rar", "bundle.tar.gz"]) {
      expect(previewKindFor({ filename, contentType: "" })).toBe("fallback");
    }
    expect(previewKindFor({ filename: "podcast.mp3", contentType: "" })).toBe("media-audio");
    expect(previewKindFor({ filename: "voice.ogg", contentType: "" })).toBe("media-audio");
    expect(previewKindFor({ filename: "clip.mp4", contentType: "" })).toBe("media-video");
    expect(previewKindFor({ filename: "clip.mpg", contentType: "" })).toBe("media-video");
    expect(mediaKind("clip.mpg")).toBe("video");
  });

  it("falls back for formats no surface can open", () => {
    for (const filename of ["setup.exe", "font.ttf", "sheet.psd", "blob"]) {
      expect(previewKindFor({ filename, contentType: "application/octet-stream" })).toBe("fallback");
    }
  });

  it("uses the MIME type only when the extension says nothing", () => {
    expect(previewKindFor({ filename: "blob", contentType: "application/pdf" })).toBe("pdf");
    expect(previewKindFor({ filename: "blob", contentType: "image/png" })).toBe("image-raster");
    expect(previewKindFor({ filename: "blob", contentType: "text/plain" })).toBe("text");
    expect(previewKindFor({ filename: "blob", contentType: "text/javascript" })).toBe("code");
    // A curated extension wins over a contradictory MIME type.
    expect(previewKindFor({ filename: "report.pdf", contentType: "image/png" })).toBe("pdf");
  });

  it("assigns the surface and tier for every kind from the plan matrix", () => {
    for (const kind of previewKinds) {
      expect(surfaceFor(kind)).toBe(expectedSurfaces[kind]);
      expect(tierFor(kind)).toBe(expectedTiers[kind]);
    }
    // Media fetches bytes like any other tier-A surface; what keeps it safe is
    // the surface contract (no autoplay, no <source>/<track>, error fallback),
    // which MediaSurface.test.tsx in S2 pins. Tier here only says "the drawer
    // may fetch", so a tier-C media entry would silently forbid the player.
    expect(tierFor("media-audio")).toBe("A");
    expect(tierFor("media-video")).toBe("A");
  });

  it("opens every kind, because every kind has a valid drawer", () => {
    for (const kind of previewKinds) {
      expect(canOpenPreview(kind)).toBe(true);
    }
  });
});

describe("sniffSignature input to the kind-mismatch gate", () => {
  it("reports the container the bytes actually are", () => {
    expect(sniffSignature(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
  });

  it("exposes a mismatch when the extension and the bytes disagree", () => {
    // `.png` declares a raster image but the bytes are a PDF: the S2 gate
    // compares `sniffSignature` against the extension-derived expectation and
    // must refuse to decode.
    const declared = previewKindFor({ filename: "photo.png", contentType: "image/png" });
    expect(declared).toBe("image-raster");
    expect(sniffSignature(new TextEncoder().encode("%PDF-1.7"))).toBe("pdf");
    expect(sniffSignature(new TextEncoder().encode("%PDF-1.7"))).not.toBe("png");
  });
});

describe("sanitizeDisplayName", () => {
  it("strips bidi overrides that forge a different extension", () => {
    expect(sanitizeDisplayName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeDisplayName("\u2066evil\u2069.txt")).toBe("evil.txt");
  });

  it("truncates at NUL without hiding the real type", () => {
    // The stored name classifies as a PDF; plain truncation would display "a"
    // and hide that. The original extension is re-attached so the label keeps
    // showing what the file actually is.
    expect(sanitizeDisplayName("a\u0000b.pdf")).toBe("a.pdf");
    expect(sanitizeDisplayName("a\u0000b")).toBe("a");
    expect(sanitizeDisplayName("a.pdf\u0000b.exe")).toBe("a.pdf");
  });

  it("strips zero-width characters used for lookalike names", () => {
    expect(sanitizeDisplayName("零宽\u200B隐写\u200D.txt")).toBe("零宽隐写.txt");
  });

  it("caps the display name at 255 code points, ellipsis included", () => {
    const truncated = sanitizeDisplayName("a".repeat(256));
    expect(Array.from(truncated)).toHaveLength(255);
    expect(truncated.endsWith("…")).toBe(true);
    // Code points, not UTF-16 units: an emoji-heavy name must not be split
    // into a lone surrogate that renders as a replacement character.
    const emoji = sanitizeDisplayName("😀".repeat(256));
    expect(Array.from(emoji)).toHaveLength(255);
    expect(emoji.endsWith("…")).toBe(true);
    expect(sanitizeDisplayName("a".repeat(255))).toHaveLength(255);
  });

  it("falls back instead of rendering an empty label", () => {
    expect(sanitizeDisplayName("\u0000\u0001\u0002")).toBe("attachment");
    expect(sanitizeDisplayName("   ")).toBe("attachment");
    expect(sanitizeDisplayName("")).toBe("attachment");
    expect(sanitizeDisplayName("\u202E\u200B")).toBe("attachment");
  });

  it("leaves ordinary names untouched", () => {
    for (const name of ["invoice.pdf", "季度报告 2026.xlsx", "photo (1).png", "résumé.docx"]) {
      expect(sanitizeDisplayName(name)).toBe(name);
    }
  });
});
