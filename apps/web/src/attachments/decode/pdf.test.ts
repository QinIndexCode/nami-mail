// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGES_PER_PAGE,
  MAX_PAGES,
  PAGE_BYTES,
  PDF_IMAGE_FILTER_BYTES,
  PDF_OPEN_DEADLINE_MS,
  canvasMaxAreaInBytes,
  maxImageSize,
} from "../budget";
import { MemoryLease } from "../budget";
import { ResourceScope } from "../document";
import type { DecodeContext, PreviewInput } from "../document";
import { PreviewFailure } from "../failure";
import { pdfFixtures } from "../testing/pdfFixtures";

const mockGetDocument = vi.fn();

class PasswordException extends Error {
  override name = "PasswordException";
}
class InvalidPDFException extends Error {
  override name = "InvalidPDFException";
}

const OPS = {
  paintInlineImageXObject: 85,
  paintImageXObject: 86,
  paintImageMaskXObject: 87,
};

vi.mock("pdfjs-dist", () => ({
  getDocument: (options: unknown) => mockGetDocument(options),
  GlobalWorkerOptions: { workerSrc: "" },
  AnnotationMode: { DISABLE: 1 },
  OPS,
  PasswordException,
  InvalidPDFException,
  version: "6.4.299",
}));

const {
  AnnotationMode,
  buildPdfOptions,
  decodePdf,
  hasPdfMagic,
  measurePageImages,
  releasePdfPage,
} = await import("./pdf");

type FakePage = {
  getOperatorList: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  getViewport: ReturnType<typeof vi.fn>;
};

type InstallOptions = {
  numPages?: number;
  images?: { objectId?: string; width: number; height: number }[];
  firstName?: string;
  rejectWith?: Error;
  never?: boolean;
};

const operatorList = (images: { objectId?: string; width: number; height: number }[] = []) => {
  const fnArray: number[] = [];
  const argsArray: unknown[] = [];
  for (const image of images) {
    if (image.objectId === undefined) {
      fnArray.push(OPS.paintInlineImageXObject);
      argsArray.push([{ width: image.width, height: image.height }]);
    } else {
      fnArray.push(OPS.paintImageXObject);
      argsArray.push([image.objectId, image.width, image.height]);
    }
  }
  return { fnArray, argsArray };
};

function install(options: InstallOptions = {}) {
  const page: FakePage = {
    getOperatorList: vi.fn(async () => operatorList(options.images)),
    cleanup: vi.fn(() => true),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 300 * scale, height: 300 * scale })),
  };
  const destroy = vi.fn(async () => undefined);
  const promise = options.never
    ? new Promise<never>(() => undefined)
    : options.rejectWith
      ? Promise.reject(options.rejectWith)
      : Promise.resolve({ numPages: options.numPages ?? 1, getPage: vi.fn(async () => page) });
  const loadingTask = { promise, destroy };
  mockGetDocument.mockReturnValue(loadingTask);
  return { page, destroy, loadingTask };
}

const context = (overrides: Partial<DecodeContext> = {}): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
  ...overrides,
});

const input = (bytes: Uint8Array, filename = "paper.pdf"): PreviewInput => ({
  kind: "pdf",
  filename,
  contentType: "application/pdf",
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

const minimalPdf = (): Uint8Array => pdfFixtures().openActionJs;

describe("pdf.js document options", () => {
  it("snapshots the hardened option set", () => {
    const options = buildPdfOptions();
    expect(options).toEqual({
      cMapUrl: "http://localhost/pdfjs/cmaps/",
      cMapPacked: true,
      iccUrl: "http://localhost/pdfjs/iccs/",
      standardFontDataUrl: "http://localhost/pdfjs/standard_fonts/",
      wasmUrl: "http://localhost/pdfjs/wasm/",
      useSystemFonts: false,
      maxImageSize: 8_912_896,
      canvasMaxAreaInBytes: 35_651_584,
      stopAtErrors: true,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
    });
    expect(options.maxImageSize).toBe(maxImageSize);
    expect(options.canvasMaxAreaInBytes).toBe(canvasMaxAreaInBytes);
    // `isEvalSupported` does not exist in this pdf.js version: asserting either
    // its presence or its value would be a tautology, so it is absent entirely.
    expect(Object.keys(options)).not.toContain("isEvalSupported");
    // `useWasm` must stay out: disabling it would turn QCMS into a naive fallback.
    expect(Object.keys(options)).not.toContain("useWasm");
  });

  it("keeps all four asset families under the same-origin /pdfjs/ prefix", () => {
    const options = buildPdfOptions();
    for (const url of [options.cMapUrl, options.iccUrl, options.standardFontDataUrl, options.wasmUrl]) {
      expect(new URL(url).origin).toBe("http://localhost");
      expect(new URL(url).pathname.startsWith("/pdfjs/")).toBe(true);
    }
  });
});

describe("magic detection", () => {
  it("accepts a PDF marker anywhere in the first KiB", () => {
    expect(hasPdfMagic(minimalPdf())).toBe(true);
    const junk = new Uint8Array([1, 2, 3, ...new TextEncoder().encode("%PDF-1.7")]);
    expect(hasPdfMagic(junk)).toBe(true);
    expect(hasPdfMagic(new TextEncoder().encode("not a pdf"))).toBe(false);
  });

  it("rejects a marker past the first KiB", () => {
    const bytes = new Uint8Array(2048 + 5);
    bytes.set(new TextEncoder().encode("%PDF-"), 2048);
    expect(hasPdfMagic(bytes)).toBe(false);
  });
});

describe("measurePageImages", () => {
  it("counts inline and embedded images, deduplicating by object id", async () => {
    const page = {
      getOperatorList: vi.fn(async () =>
        operatorList([
          { width: 10, height: 10 },
          { objectId: "img_1", width: 100, height: 100 },
          { objectId: "img_1", width: 100, height: 100 },
          { objectId: "img_2", width: 20, height: 20 },
        ]),
      ),
    };
    await expect(measurePageImages(page as never)).resolves.toEqual({ images: 3, pixels: 100 * 100 + 20 * 20 + 100 });
  });

  it("reports an image budget excess through the page failure path", async () => {
    const { page, destroy } = install({
      images: Array.from({ length: MAX_IMAGES_PER_PAGE + 1 }, (_, index) => ({
        objectId: `img_${index}`,
        width: 10,
        height: 10,
      })),
    });
    const failure = await decodePdf(input(minimalPdf()), context()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreviewFailure);
    expect((failure as PreviewFailure).code).toBe("image_budget_exceeded");
    expect(page.cleanup).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });
});

describe("decodePdf", () => {
  beforeEach(() => {
    mockGetDocument.mockReset();
  });

  it("charges the ledger and returns a page-1 pdf surface", async () => {
    const { page } = install({ numPages: 3, images: [{ width: 100, height: 100 }] });
    const lease = new MemoryLease();
    const document = await decodePdf(input(minimalPdf()), context({ lease }));
    expect(document.surface).toMatchObject({ surface: "pdf", pageCount: 3, page: 1 });
    expect(document.pdf?.pageCount).toBe(3);
    expect(document.surface.surface === "pdf" && document.surface.documentId).toMatch(/^pdf-/);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(lease.used).toBe(PAGE_BYTES + PDF_IMAGE_FILTER_BYTES);
  });

  it("passes exactly the fixture bytes to getDocument", async () => {
    const fixtures = pdfFixtures();
    for (const bytes of Object.values(fixtures)) {
      install();
      await decodePdf(input(bytes), context());
      const options = mockGetDocument.mock.calls.at(-1)?.[0] as { data: Uint8Array };
      expect(options.data).toBe(bytes);
      expect(options.data.byteLength).toBe(bytes.byteLength);
    }
  });

  it("rejects a non-PDF before loading pdf.js", async () => {
    await expect(decodePdf(input(new TextEncoder().encode("hello")), context())).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it("rejects more than the page ceiling and destroys the loading task", async () => {
    const { destroy } = install({ numPages: MAX_PAGES + 1 });
    await expect(decodePdf(input(minimalPdf()), context())).rejects.toMatchObject({ code: "too_many_pages" });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("accepts the exact page ceiling", async () => {
    install({ numPages: MAX_PAGES });
    const document = await decodePdf(input(minimalPdf()), context());
    expect(document.pdf?.pageCount).toBe(MAX_PAGES);
  });

  it("maps an encrypted document to the encrypted failure", async () => {
    install({ rejectWith: new PasswordException("needs a password") });
    await expect(decodePdf(input(minimalPdf()), context())).rejects.toMatchObject({ code: "encrypted" });
  });

  it("maps an invalid document to corrupt", async () => {
    install({ rejectWith: new InvalidPDFException("broken xref") });
    await expect(decodePdf(input(minimalPdf()), context())).rejects.toMatchObject({ code: "corrupt" });
  });

  it("maps a removed oversized image to image_budget_exceeded", async () => {
    install({ rejectWith: new Error("Image exceeded maximum allowed size and was removed.") });
    await expect(decodePdf(input(minimalPdf()), context())).rejects.toMatchObject({ code: "image_budget_exceeded" });
  });

  it("times out opening and destroys the task exactly once", async () => {
    vi.useFakeTimers();
    const { destroy } = install({ never: true });
    const pending = decodePdf(input(minimalPdf()), context());
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(PDF_OPEN_DEADLINE_MS);
    await assertion;
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("releasePdfPage", () => {
  it("cancels the render task, then cleans the page", async () => {
    const cancel = vi.fn(async () => undefined);
    const page = { cleanup: vi.fn(() => true) };
    const loadingTask = { destroy: vi.fn(async () => undefined) };
    await releasePdfPage(page as never, loadingTask as never, { renderTask: { cancel } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(loadingTask.destroy).not.toHaveBeenCalled();
  });

  it("retries cleanup and destroys the document when it never succeeds", async () => {
    const page = { cleanup: vi.fn(() => false) };
    const loadingTask = { destroy: vi.fn(async () => undefined) };
    await releasePdfPage(page as never, loadingTask as never);
    expect(page.cleanup).toHaveBeenCalledTimes(3);
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the document when the whole preview is dropped", async () => {
    const page = { cleanup: vi.fn(() => true) };
    const loadingTask = { destroy: vi.fn(async () => undefined) };
    await releasePdfPage(page as never, loadingTask as never, { destroyTask: true });
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("AnnotationMode", () => {
  it("re-exports the library value so the render layer never imports pdfjs-dist", () => {
    expect(AnnotationMode.DISABLE).toBe(1);
  });
});
