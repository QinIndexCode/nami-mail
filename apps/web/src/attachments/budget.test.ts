import { describe, expect, it } from "vitest";
import {
  ARCHIVE_ENTRY_BYTES,
  BLOCK_BYTES,
  BUFFER_BYTES,
  DECODE_DEADLINE_MS,
  DOM_ELEMENT_BYTES,
  INGRESS_BASE_MS,
  INGRESS_MAX_MS,
  INGRESS_PER_MIB_MS,
  MARKDOWN_BLOCK_BYTES,
  MAX_ARCHIVE_DECLARED_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_IMAGE_PIXELS_PER_PAGE,
  MAX_IMAGES_PER_PAGE,
  MAX_INPUT_BYTES,
  MAX_MARKDOWN_BLOCKS,
  MAX_MARKDOWN_BYTES,
  MAX_MEMORY_BYTES,
  MAX_OFFICE_BLOCKS,
  MAX_OFFICE_CHARS,
  MAX_OFFICE_ELEMENTS,
  MAX_OOXML_ENTRIES,
  MAX_PAGE_PIXELS,
  MAX_PAGES,
  MAX_RETAINED_CHARS,
  MAX_SHEET_SLOTS,
  MAX_UNZIPPED_BYTES,
  MAX_ZIP_ENTRY_BYTES,
  MemoryLease,
  MIB,
  PAGE_BYTES,
  PAGE_PIXELS_MAX,
  PDF_FIRST_PAGE_MS,
  PDF_IMAGE_BYTES,
  PDF_IMAGE_FILTER_BYTES,
  PDF_OPEN_DEADLINE_MS,
  PDF_PAGE_MS,
  RESERVE_BYTES,
  SHEET_SLOT_BYTES,
  attachmentTimeoutMsFor,
  canvasMaxAreaInBytes,
  maxImageSize,
  worstCaseBytes,
} from "./budget";
import { PreviewFailure } from "./failure";

describe("preview budget constants", () => {
  it("keeps every input ceiling where the plan put it", () => {
    expect(MAX_INPUT_BYTES).toEqual({
      pdf: 32 * MIB,
      office: 32 * MIB,
      archive: 32 * MIB,
      image: 32 * MIB,
      media: 32 * MIB,
      text: 20 * MIB,
      code: 20 * MIB,
      markdown: 8 * MIB,
    });
    expect(MAX_MARKDOWN_BYTES).toBe(8 * MIB);
    expect(MAX_MARKDOWN_BLOCKS).toBe(4_000);
    expect(MAX_RETAINED_CHARS).toBe(64_000);
  });

  it("derives the pdf.js image gates from one pixel figure", () => {
    expect(maxImageSize).toBe(8_912_896);
    expect(MAX_IMAGE_PIXELS_PER_PAGE).toBe(maxImageSize);
    expect(MAX_IMAGES_PER_PAGE).toBe(3);
    // canvasMaxAreaInBytes = 4 × maxImageSize: no accepted image is resized via
    // the BMP round trip, and pdf.js' own `_guessMax` cannot be hit.
    expect(canvasMaxAreaInBytes).toBe(4 * maxImageSize);
    // Decode-ledger charge for a JPEG-shaped image is 4 B/px; the Flate-shaped
    // one is 11 B/px and is the number the worst case must use.
    expect(PDF_IMAGE_BYTES).toBe(maxImageSize * 4);
    expect(PDF_IMAGE_FILTER_BYTES).toBe(MAX_IMAGE_PIXELS_PER_PAGE * 11);
    expect(MAX_IMAGES_PER_PAGE * PDF_IMAGE_BYTES).toBe(106_954_752);
  });

  it("keeps the page, archive and office ceilings", () => {
    expect(MAX_PAGE_PIXELS).toBe(8_388_608);
    expect(PAGE_PIXELS_MAX).toBe(4_800_000);
    expect(PAGE_BYTES).toBe(19_200_000);
    expect(MAX_PAGES).toBe(200);
    expect(MAX_ARCHIVE_ENTRIES).toBe(200);
    expect(MAX_ARCHIVE_DECLARED_BYTES).toBe(256 * MIB);
    expect(MAX_UNZIPPED_BYTES).toBe(32 * MIB);
    expect(MAX_ZIP_ENTRY_BYTES).toBe(16 * MIB);
    expect(MAX_OOXML_ENTRIES).toBe(2_000);
    expect(MAX_OFFICE_ELEMENTS).toBe(50_000);
    expect(MAX_OFFICE_BLOCKS).toBe(4_000);
    expect(MAX_OFFICE_CHARS).toBe(1_000_000);
  });

  it("keeps the four deadlines and the chunk buffer", () => {
    expect(INGRESS_BASE_MS).toBe(60_000);
    expect(INGRESS_PER_MIB_MS).toBe(20_000);
    expect(INGRESS_MAX_MS).toBe(180_000);
    expect(DECODE_DEADLINE_MS).toBe(15_000);
    expect(PDF_OPEN_DEADLINE_MS).toBe(15_000);
    expect(PDF_FIRST_PAGE_MS).toBe(8_000);
    expect(PDF_PAGE_MS).toBe(5_000);
    expect(BUFFER_BYTES).toBe(131_072);
    expect(MAX_MEMORY_BYTES).toBe(192 * MIB);
  });
});

describe("worst-case ledger", () => {
  it("matches the §9.3 formulas branch by branch", () => {
    expect(worstCaseBytes("pdf")).toBe(150_927_360);
    expect(worstCaseBytes("office")).toBe(79_351_936);
    expect(worstCaseBytes("image")).toBe(67_239_936);
    expect(worstCaseBytes("text")).toBe(21_358_592);
    expect(worstCaseBytes("markdown")).toBe(9_031_680);
    expect(worstCaseBytes("archive")).toBe(33_890_304);
    expect(worstCaseBytes("media")).toBe(33_685_504);
  });

  it("charges a media payload only its input and the chunk buffer", () => {
    expect(worstCaseBytes("media")).toBe(32 * MIB + BUFFER_BYTES);
    expect(worstCaseBytes("media")).toBe(MAX_INPUT_BYTES.media + BUFFER_BYTES);
  });

  it("composes each branch from the public constants", () => {
    expect(worstCaseBytes("pdf")).toBe(
      MAX_INPUT_BYTES.pdf + PAGE_BYTES + PDF_IMAGE_FILTER_BYTES + BUFFER_BYTES,
    );
    expect(worstCaseBytes("office")).toBe(
      MAX_INPUT_BYTES.office
        + MAX_ZIP_ENTRY_BYTES * 2
        + MAX_OFFICE_ELEMENTS * DOM_ELEMENT_BYTES
        + MAX_OFFICE_BLOCKS * BLOCK_BYTES
        + MAX_OFFICE_CHARS * 2
        + MAX_SHEET_SLOTS * SHEET_SLOT_BYTES
        + BUFFER_BYTES,
    );
    expect(worstCaseBytes("image")).toBe(MAX_INPUT_BYTES.image + MAX_PAGE_PIXELS * 4 + BUFFER_BYTES);
    expect(worstCaseBytes("text")).toBe(MAX_INPUT_BYTES.text + MAX_RETAINED_CHARS * 4 + BUFFER_BYTES);
    expect(worstCaseBytes("markdown")).toBe(
      MAX_MARKDOWN_BYTES + MAX_RETAINED_CHARS * 4 + MAX_MARKDOWN_BLOCKS * MARKDOWN_BLOCK_BYTES + BUFFER_BYTES,
    );
    expect(worstCaseBytes("archive")).toBe(
      MAX_INPUT_BYTES.archive + MAX_ARCHIVE_ENTRIES * ARCHIVE_ENTRY_BYTES + BUFFER_BYTES,
    );
    expect(DOM_ELEMENT_BYTES).toBe(160);
    expect(BLOCK_BYTES).toBe(128);
    expect(MARKDOWN_BLOCK_BYTES).toBe(64);
    expect(ARCHIVE_ENTRY_BYTES).toBe(1024);
  });

  it("keeps the 16 MiB reserve on every branch", () => {
    const branches = ["pdf", "office", "image", "text", "markdown", "archive", "media"] as const;
    for (const branch of branches) {
      expect(worstCaseBytes(branch) + RESERVE_BYTES).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    }
    expect(RESERVE_BYTES).toBe(16 * MIB);
    expect(MAX_MEMORY_BYTES - (worstCaseBytes("pdf") + RESERVE_BYTES)).toBe(33_622_016);
  });
});

describe("ingress deadline", () => {
  it("scales with the payload and clamps at the cap", () => {
    expect(attachmentTimeoutMsFor(0)).toBe(60_000);
    expect(attachmentTimeoutMsFor(1 * MIB)).toBe(80_000);
    expect(attachmentTimeoutMsFor(3 * MIB)).toBe(120_000);
    expect(attachmentTimeoutMsFor(7 * MIB)).toBe(180_000);
    expect(attachmentTimeoutMsFor(32 * MIB)).toBe(INGRESS_MAX_MS);
    expect(attachmentTimeoutMsFor(-1)).toBe(INGRESS_BASE_MS);
  });
});

describe("MemoryLease", () => {
  it("rejects the allocation that would cross the limit instead of half-charging", () => {
    const lease = new MemoryLease(10);
    lease.charge(10);
    expect(lease.used).toBe(10);
    expect(() => lease.charge(1)).toThrowError(PreviewFailure);
    try {
      lease.charge(1);
    } catch (error) {
      expect((error as PreviewFailure).code).toBe("too_large");
    }
    expect(lease.used).toBe(10);
  });

  it("releases exactly the charged bytes", () => {
    const lease = new MemoryLease(100);
    lease.charge(40, "bytes");
    lease.charge(30, "dom");
    lease.release(30);
    expect(lease.used).toBe(40);
    lease.release(100);
    expect(lease.used).toBe(0);
  });

  it("charges text at two bytes per UTF-8 byte", () => {
    const lease = new MemoryLease();
    lease.chargeText(3);
    expect(lease.used).toBe(6);
  });

  it("defaults to the shared ceiling", () => {
    const lease = new MemoryLease();
    expect(() => lease.charge(MAX_MEMORY_BYTES)).not.toThrow();
    expect(() => lease.charge(1)).toThrowError(PreviewFailure);
  });
});
