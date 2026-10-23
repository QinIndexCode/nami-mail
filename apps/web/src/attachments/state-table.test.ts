// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { translate } from "../i18n";
import {
  DECODE_DEADLINE_MS,
  MAX_ARCHIVE_ENTRIES,
  MAX_IMAGE_PIXELS_PER_PAGE,
  MAX_PAGES,
  MemoryLease,
} from "./budget";
import { decodeAttachment, decodeImage, decodeText } from "./decode";
import { ResourceScope, type DecodeContext, type PreviewInput } from "./document";
import {
  PreviewCanceled,
  PreviewFailure,
  failureCodes,
  failureFromUnknown,
  failurePresentation,
  pageFailureCodes,
  previewFailurePresentations,
  previewStates,
  type FailureCode,
} from "./failure";
import { openAttachmentResponse, setAttachmentResponseProvider } from "./ingress";
import { encodeFixtureText, makeZip, makeZipBomb, makeZipEncrypted, makeZipManyEntries } from "./testing/fixtures";
import { ZipReader } from "./zip/reader";

/**
 * The 13-state × 14-code × 16-key table (plan §10), plus the rule that
 * `failurePresentation` returns a key and never a value: the drawer supplies
 * `{seconds}`/`{max}` itself, so the sentence and the number cannot disagree.
 *
 * Eleven of the fourteen codes are built here through the real stages. The
 * three that cannot be cheaply built in this file name the test that owns their
 * construction, rather than pretending a `new PreviewFailure(code)` proves a
 * decoder can emit them.
 */

const context = (overrides: Partial<DecodeContext> = {}): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
  ...overrides,
});

const input = (bytes: Uint8Array, kind: PreviewInput["kind"], filename: string, contentType: string): PreviewInput => ({
  kind,
  filename,
  contentType,
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

async function codeFrom(run: () => Promise<unknown> | unknown): Promise<FailureCode> {
  try {
    await run();
  } catch (error) {
    const normalized = failureFromUnknown(error);
    if (normalized instanceof PreviewCanceled) throw new Error("construction was cancelled, not failed");
    return normalized.code;
  }
  throw new Error("the construction did not fail");
}

async function codeFromStatus(status: number): Promise<FailureCode> {
  setAttachmentResponseProvider(async () => new Response(null, { status }));
  try {
    return await codeFrom(() => openAttachmentResponse("message-1", "part-1"));
  } finally {
    setAttachmentResponseProvider(null);
  }
}

/** A ZIP64 end record: the reader refuses the marker rather than guessing. */
function zip64EndRecord(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(10, 0xffff, true);
  return bytes;
}

const bigSvg = encodeFixtureText(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="10" height="10"/></svg>',
);

/**
 * Real constructions. Everything not listed here needs a PDF or a full session
 * to trigger, and is covered where that fixture already exists:
 * `empty` → session.test.ts, `too_many_pages` / `image_budget_exceeded` →
 * pdf.test.ts.
 */
const constructions: Record<string, () => Promise<FailureCode> | FailureCode> = {
  too_large: () => codeFromStatus(413),
  network: () => codeFromStatus(500),
  decoded_too_large: async () => {
    const zip = await makeZip([{ name: "big.txt", data: new Uint8Array(2_000).fill(65) }]);
    const reader = ZipReader.open(zip.bytes, { maxEntries: 200, maxEntryBytes: 64 });
    return codeFrom(() => reader.readEntry("big.txt"));
  },
  too_many_entries: async () => {
    const zip = await makeZipManyEntries({ count: MAX_ARCHIVE_ENTRIES + 1 });
    return codeFrom(() => ZipReader.open(zip.bytes, { maxEntries: MAX_ARCHIVE_ENTRIES }));
  },
  zip_bomb: async () => {
    const bomb = await makeZipBomb();
    const reader = ZipReader.open(bomb.bytes, { maxEntries: 200 });
    return codeFrom(() => reader.readEntry(bomb.entryName));
  },
  encrypted: async () => {
    const zip = await makeZipEncrypted();
    const reader = ZipReader.open(zip.bytes, { maxEntries: 200 });
    return codeFrom(() => reader.readEntry("secret.txt"));
  },
  corrupt: () => codeFrom(() => ZipReader.open(new Uint8Array(8), { maxEntries: 200 })),
  unsupported: () => codeFrom(() => ZipReader.open(zip64EndRecord(), { maxEntries: 200 })),
  kind_mismatch: () =>
    codeFrom(() => decodeAttachment(input(bigSvg, "image-raster", "mismatch.png", "image/png"), context())),
  pixels_too_large: () =>
    codeFrom(() => decodeImage(input(bigSvg, "image-vector", "huge.svg", "image/svg+xml"), context())),
  timeout: () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls * 10_000;
    };
    return codeFrom(() =>
      decodeText(input(encodeFixtureText("a".repeat(200_000)), "text", "slow.txt", "text/plain"), context({ now })),
    );
  },
};

describe("preview state table", () => {
  it("holds 13 states, 14 codes and the four page-scoped codes", () => {
    expect(previewStates).toHaveLength(13);
    expect(new Set(previewStates).size).toBe(13);
    expect(failureCodes).toHaveLength(14);
    expect(new Set(failureCodes).size).toBe(14);
    expect(pageFailureCodes).toEqual(["pixels_too_large", "image_budget_exceeded", "corrupt", "timeout"]);
  });

  it("has one presentation per code, all pointing at real error states", () => {
    expect(Object.keys(previewFailurePresentations).sort()).toEqual([...failureCodes].sort());
    for (const code of failureCodes) {
      const presentation = failurePresentation(code);
      expect(previewStates, code).toContain(presentation.state);
      expect(presentation.state.startsWith("error_"), code).toBe(true);
      expect(Object.keys(presentation).sort(), `${code} carries values`).toEqual(["messageKey", "state"]);
    }
  });

  it("covers exactly the seven error states", () => {
    const reached = new Set(failureCodes.map((code) => failurePresentation(code).state));
    expect([...reached].sort()).toEqual([
      "error_corrupt",
      "error_encrypted",
      "error_network",
      "error_timeout",
      "error_too_large",
      "error_too_many_entries",
      "error_unsupported",
    ]);
  });

  it("uses twelve distinct translated keys, none of them invented", () => {
    const keys = new Set(failureCodes.map((code) => failurePresentation(code).messageKey));
    expect(keys.size).toBe(12);
    for (const key of keys) {
      expect(key.startsWith("mail.attachment.preview"), key).toBe(true);
      for (const locale of ["zh-CN", "en-US"]) {
        const resolved = translate(locale, key);
        expect(resolved, `${locale} ${key}`).not.toBe(key);
        expect(resolved.trim(), `${locale} ${key}`).not.toBe("");
      }
    }
  });

  it("renders its numbers through t(), never leaves a literal placeholder", () => {
    const cases: [FailureCode, Record<string, string | number>, string][] = [
      ["timeout", { seconds: Math.round(DECODE_DEADLINE_MS / 1_000) }, String(Math.round(DECODE_DEADLINE_MS / 1_000))],
      ["pixels_too_large", { max: MAX_IMAGE_PIXELS_PER_PAGE }, String(MAX_IMAGE_PIXELS_PER_PAGE)],
      ["too_many_pages", { max: MAX_PAGES }, String(MAX_PAGES)],
      ["too_many_entries", { max: MAX_ARCHIVE_ENTRIES }, String(MAX_ARCHIVE_ENTRIES)],
    ];
    for (const [code, values, expected] of cases) {
      const key = failurePresentation(code).messageKey;
      for (const locale of ["zh-CN", "en-US"]) {
        const rendered = translate(locale, key, values);
        expect(rendered, `${locale} ${code}`).toContain(expected);
        expect(rendered, `${locale} ${code}`).not.toContain("{");
      }
    }
    // A first page over the image budget reuses the page-level sentence, which
    // states no number; passing `{max}` to it must stay a no-op.
    const budgetKey = failurePresentation("image_budget_exceeded").messageKey;
    for (const locale of ["zh-CN", "en-US"]) {
      const rendered = translate(locale, budgetKey, { max: MAX_IMAGE_PIXELS_PER_PAGE });
      expect(rendered, `${locale} image_budget_exceeded`).not.toContain("{");
    }
  });

  it("builds every cheap code through the real stage", async () => {
    for (const [code, build] of Object.entries(constructions)) {
      expect(await build(), code).toBe(code);
    }
    // The codes not built here still have a presentation; the owning test is
    // named in the doc comment above.
    for (const code of ["empty", "too_many_pages", "image_budget_exceeded"] as const) {
      expect(failurePresentation(code).state.startsWith("error_"), code).toBe(true);
    }
  });

  it("normalises unknown throws to corrupt and aborts to cancellation", () => {
    expect(failureFromUnknown(new TypeError("boom"))).toMatchObject({ code: "corrupt" });
    const abort = failureFromUnknown(new DOMException("aborted", "AbortError"));
    expect(abort).toBeInstanceOf(PreviewCanceled);
    expect(failureFromUnknown(new PreviewFailure("encrypted"))).toMatchObject({ code: "encrypted" });
  });
});
