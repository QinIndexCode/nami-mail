import { PreviewFailure } from "./failure";

/**
 * The one numeric source for every preview budget (plan §9).
 *
 * Nothing else in the preview code may carry a literal byte/pixel/time limit:
 * a second copy of `8_912_896` somewhere else is how the S0 numbers drifted
 * apart in the first place, and the values here are grouped (see
 * `worstCaseBytes`) so that changing one forces the whole ledger to be
 * re-derived instead of silently blowing a later constraint.
 */

const KIB = 1024;
export const MIB = 1024 * KIB;

/**
 * Input ceilings, per pipeline branch.
 *
 * `text`/`code` stop at 20 MiB because they are decoded to a string the user
 * reads, while every container format gets 32 MiB: one cap shared by five
 * branches is a fact about how the response is buffered (the whole payload is
 * held in memory as bytes regardless), not a per-format judgement.
 */
export const MAX_INPUT_BYTES = {
  pdf: 32 * MIB,
  office: 32 * MIB,
  archive: 32 * MIB,
  image: 32 * MIB,
  media: 32 * MIB,
  text: 20 * MIB,
  code: 20 * MIB,
  markdown: 8 * MIB,
} as const;

export type BudgetBranch = keyof typeof MAX_INPUT_BYTES;

export const MAX_MARKDOWN_BYTES = 8 * MIB;
export const MAX_MARKDOWN_BLOCKS = 4_000;

/** Size ceiling of one page / one standalone image: 4096 × 2048. */
export const MAX_PAGE_PIXELS = 8_388_608;

/** pdf.js `maxImageSize`: a per-image pixel gate enforced before decoding. */
export const maxImageSize = 8_912_896;
/** Sum of the image pixels on one page (post-hoc, see `MAX_IMAGES_PER_PAGE`). */
export const MAX_IMAGE_PIXELS_PER_PAGE = 8_912_896;
export const MAX_IMAGES_PER_PAGE = 3;
/** pdf.js `canvasMaxAreaInBytes`: `4 × maxImageSize`, so no accepted image is resized through BMP. */
export const canvasMaxAreaInBytes = 35_651_584;
/** JPEG-shaped decode budget for one embedded image: 4 B/px. */
export const PDF_IMAGE_BYTES = 35_651_584;
/**
 * Flate/PNG-shaped decode budget for one embedded image: 11 B/px.
 *
 * The ledger must charge the worse of the two because the format is not known
 * before the decode starts; using `PDF_IMAGE_BYTES` here would understate the
 * PDF branch by 62 MiB (see plan §9.3).
 */
export const PDF_IMAGE_FILTER_BYTES = 98_041_856;

export const MAX_OFFICE_ELEMENTS = 50_000;
export const MAX_OFFICE_BLOCKS = 4_000;
export const MAX_OFFICE_CHARS = 1_000_000;

/**
 * The sheet window one surface retains: 200 rows × 50 columns.
 *
 * The renderer has always sliced to this window, but the decoder used to keep
 * every row and column it read, so a 539-byte package with a single `r="ZZZZ1"`
 * cell expanded into 475,254 empty array slots that neither `MAX_OFFICE_CHARS`
 * (they hold no text) nor the element ceiling (one cell) could see. The window
 * is now enforced where the allocation happens, and the renderer imports these
 * two numbers instead of restating them, so the halves cannot drift apart.
 */
export const MAX_SHEET_ROWS = 200;
export const MAX_SHEET_COLUMNS = 50;
/** One retained cell slot is a pointer in a row array; its text is charged separately. */
export const SHEET_SLOT_BYTES = 8;
/**
 * Total retained slots across every sheet of one workbook.
 *
 * A package can declare thousands of sheets (entry ceiling is 2,000), each
 * filling its own 200 × 50 window; per-sheet limits alone would still allow
 * 20M slots. Ten times one sheet's window covers real workbooks and turns an
 * absurd one into the download card the character ceiling already uses.
 */
export const MAX_SHEET_SLOTS = 200_000;

export const MAX_UNZIPPED_BYTES = 32 * MIB;
export const MAX_ZIP_ENTRY_BYTES = 16 * MIB;
export const MAX_ARCHIVE_DECLARED_BYTES = 256 * MIB;
export const MAX_ARCHIVE_ENTRIES = 200;
export const MAX_OOXML_ENTRIES = 2_000;

/** Retained text prefix, counted in code points so an emoji is never cut in half. */
export const MAX_RETAINED_CHARS = 64_000;

/** Page-canvas pixel budget (not the page-size ceiling above). */
export const PAGE_PIXELS_MAX = 4_800_000;
export const PAGE_BYTES = 19_200_000;

/** Streaming chunk size used by the text/zip loops. */
export const BUFFER_BYTES = 131_072;

export const MAX_PAGES = 200;
export const MAX_MEMORY_BYTES = 192 * MIB;
/** Headroom kept free by every branch: the assertion in `budget.test.ts` is `worst + reserve ≤ max`. */
export const RESERVE_BYTES = 16 * MIB;

export const INGRESS_BASE_MS = 60_000;
export const INGRESS_PER_MIB_MS = 20_000;
export const INGRESS_MAX_MS = 180_000;

export const DECODE_DEADLINE_MS = 15_000;
export const PDF_OPEN_DEADLINE_MS = 15_000;
export const PDF_FIRST_PAGE_MS = 8_000;
export const PDF_PAGE_MS = 5_000;

/** Per-element DOM estimate (Blink holds 96–160 B per Element; take the ceiling). */
export const DOM_ELEMENT_BYTES = 160;
/** Per-block object estimate (block plus its text reference). */
export const BLOCK_BYTES = 128;
/** Markdown block object is smaller than an office block: it has no style metadata. */
export const MARKDOWN_BLOCK_BYTES = 64;
/** Archive entry metadata: central-directory row (path, sizes, offsets). */
export const ARCHIVE_ENTRY_BYTES = KIB;

export type WorstCaseBranch = "pdf" | "office" | "image" | "text" | "markdown" | "archive" | "media";

/**
 * Worst-case resident bytes for one branch (plan §9.3).
 *
 * Every formula is `input + decode working set + chunk buffer`. The PDF branch
 * dominates because pdf.js can materialise a full-size RGBA image on top of the
 * page canvas; the media branch is the opposite extreme — the blob URL does not
 * copy bytes and the browser's media pipeline decodes outside the JS heap, so
 * this branch is input plus the chunk buffer and nothing else.
 */
export function worstCaseBytes(branch: WorstCaseBranch): number {
  switch (branch) {
    case "pdf":
      return MAX_INPUT_BYTES.pdf + PAGE_BYTES + PDF_IMAGE_FILTER_BYTES + BUFFER_BYTES;
    case "office":
      // One XML part held as a UTF-16 string, the DOM estimate, the counted
      // blocks, the retained characters and the sheet slot arrays are five
      // distinct allocations.
      return MAX_INPUT_BYTES.office
        + MAX_ZIP_ENTRY_BYTES * 2
        + MAX_OFFICE_ELEMENTS * DOM_ELEMENT_BYTES
        + MAX_OFFICE_BLOCKS * BLOCK_BYTES
        + MAX_OFFICE_CHARS * 2
        + MAX_SHEET_SLOTS * SHEET_SLOT_BYTES
        + BUFFER_BYTES;
    case "image":
      return MAX_INPUT_BYTES.image + MAX_PAGE_PIXELS * 4 + BUFFER_BYTES;
    case "text":
      return MAX_INPUT_BYTES.text + MAX_RETAINED_CHARS * 2 * 2 + BUFFER_BYTES;
    case "markdown":
      return MAX_MARKDOWN_BYTES
        + MAX_RETAINED_CHARS * 2 * 2
        + MAX_MARKDOWN_BLOCKS * MARKDOWN_BLOCK_BYTES
        + BUFFER_BYTES;
    case "archive":
      return MAX_INPUT_BYTES.archive + MAX_ARCHIVE_ENTRIES * ARCHIVE_ENTRY_BYTES + BUFFER_BYTES;
    case "media":
      return MAX_INPUT_BYTES.media + BUFFER_BYTES;
  }
}

/**
 * Binary ingress deadline for a payload of `bytes` (mirrors the transport's
 * rule): 60 s plus 20 s per MiB, capped at 180 s.
 *
 * The download path does not learn its length up front, so the ingress timer is
 * recomputed as bytes arrive instead of being fixed at the start; this function
 * is that recomputation.
 */
export function attachmentTimeoutMsFor(bytes: number): number {
  return Math.min(INGRESS_MAX_MS, INGRESS_BASE_MS + Math.ceil(Math.max(0, bytes) / MIB) * INGRESS_PER_MIB_MS);
}

export type LeaseCharge = { bytes: number; what: string };

/**
 * The JS-heap ledger (plan §9.2).
 *
 * It only bounds allocations this repository makes: browser and pdf.js internal
 * structures are deliberately outside it, which is why the ADR must not describe
 * it as a total memory cap. `charge` runs *before* the allocation so an
 * over-budget branch fails instead of half-allocating.
 */
export class MemoryLease {
  private readonly allocations: LeaseCharge[] = [];

  constructor(readonly limit: number = MAX_MEMORY_BYTES) {}

  get used(): number {
    return this.allocations.reduce((total, allocation) => total + allocation.bytes, 0);
  }

  charge(bytes: number, what = "allocation"): void {
    const next = this.used + bytes;
    if (next > this.limit) throw new PreviewFailure("too_large");
    this.allocations.push({ bytes, what });
  }

  release(bytes: number): void {
    let remaining = bytes;
    while (remaining > 0 && this.allocations.length > 0) {
      const last = this.allocations[this.allocations.length - 1]!;
      if (last.bytes <= remaining) {
        remaining -= last.bytes;
        this.allocations.pop();
      } else {
        this.allocations[this.allocations.length - 1] = { ...last, bytes: last.bytes - remaining };
        remaining = 0;
      }
    }
  }

  /**
   * A decompressed/decoded part is held as a UTF-16 string, so its JS-heap cost
   * is twice the UTF-8 length. Streamed paths must charge only their retained
   * prefix with this same helper instead of charging the whole input again.
   */
  chargeText(utf8Bytes: number): void {
    this.charge(utf8Bytes * 2, "text");
  }
}
