// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_PIXELS_MAX } from "../budget";
import { ResourceScope } from "../document";
import { PageFailure } from "../failure";
import { documentWith, flush, mount, zh } from "../testing/surfaceHarness";
import PdfSurface from "./PdfSurface";

const mocks = vi.hoisted(() => ({
  measureOperatorList: vi.fn(() => ({ images: 0, pixels: 0 })),
  pageBudgetFailure: vi.fn((): unknown => null),
  releasePdfPage: vi.fn(async () => undefined),
}));

vi.mock("../decode", () => ({
  AnnotationMode: { DISABLE: 7 },
  measureOperatorList: mocks.measureOperatorList,
  pageBudgetFailure: mocks.pageBudgetFailure,
  releasePdfPage: mocks.releasePdfPage,
  // The surface's page budget is what this file tests; the deadline wrapper is
  // covered by deadline.test.ts and would only make every case asynchronous.
  withTimeout: (work: Promise<unknown>) => work,
}));

const loadingTask = { destroy: vi.fn(async () => undefined) };

type FakePage = {
  getViewport: ReturnType<typeof vi.fn>;
  getOperatorList: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
};

const makePage = (width = 300, height = 400): FakePage => ({
  getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })),
  getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
  render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
  cleanup: vi.fn(() => true),
});

const pdfDocument = ({ pageCount = 3 }: { pageCount?: number } = {}) => {
  const pages = Array.from({ length: pageCount }, () => makePage());
  const getPage = vi.fn(async (pageNumber: number) => pages[pageNumber - 1]);
  return {
    pages,
    getPage,
    handle: { documentId: "pdf-test", pageCount, pdf: { getPage }, loadingTask } as never,
  };
};

const pdfSurface = (handle: unknown, overrides: Record<string, unknown> = {}) =>
  documentWith(
    { surface: "pdf", documentId: "pdf-test", pageCount: 3, page: 1 },
    { kind: "pdf", filename: "paper.pdf", contentType: "application/pdf", pdf: handle as never, ...overrides },
  );

beforeEach(() => {
  mocks.releasePdfPage.mockClear();
  mocks.measureOperatorList.mockClear();
  mocks.pageBudgetFailure.mockReset();
  mocks.pageBudgetFailure.mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PdfSurface", () => {
  it("renders the page label, a named canvas and a disabled previous button", async () => {
    const { handle } = pdfDocument();
    const { container, unmount } = await mount(
      <PdfSurface document={pdfSurface(handle)} scope={scope()} onDownload={() => undefined} />,
    );
    await flush();
    expect(container.textContent).toContain(zh("mail.attachment.previewPageOf", { page: 1, total: 3 }));
    // The toolbar's action is labelled with the filename; the download-only
    // sentence belongs to the card that has no preview, not to a working one.
    expect(container.querySelector(".attachment-preview-download")?.textContent).toContain(
      zh("mail.attachment.download", { filename: "paper.pdf" }),
    );
    expect(container.textContent).not.toContain(zh("mail.attachment.previewDownloadOnly"));
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.getAttribute("aria-label")).toContain("paper.pdf");
    expect(container.querySelector('button[aria-label="' + zh("mail.attachment.previewPrevPage") + '"]')).toHaveProperty(
      "disabled",
      true,
    );
    await unmount();
  });

  it("renders with annotations disabled and a canvas sized from the viewport", async () => {
    const { handle, pages } = pdfDocument();
    const { container, unmount } = await mount(
      <PdfSurface document={pdfSurface(handle)} scope={scope()} onDownload={() => undefined} />,
    );
    await flush();
    const canvas = container.querySelector("canvas");
    expect(pages[0].render).toHaveBeenCalledTimes(1);
    const args = pages[0].render.mock.calls[0][0] as { canvas: HTMLCanvasElement; annotationMode: number };
    expect(args.canvas).toBe(canvas);
    // 7, not pdfjs's real `DISABLE` (1): the mock above deliberately picks a
    // value the library does not use, so a surface that imported `AnnotationMode`
    // from anywhere but `../decode` (or hardcoded the library number) fails here.
    expect(args.annotationMode).toBe(7);
    expect(canvas?.width).toBe(300);
    expect(canvas?.height).toBe(400);
    await unmount();
  });

  it("caps the render scale by the page pixel budget", async () => {
    const tall = makePage(3000, 4000);
    const getPage = vi.fn(async () => tall);
    const handle = { documentId: "pdf-test", pageCount: 1, pdf: { getPage }, loadingTask } as never;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const { container, unmount } = await mount(
      <PdfSurface
        document={documentWith(
          { surface: "pdf", documentId: "pdf-test", pageCount: 1, page: 1 },
          { kind: "pdf", filename: "tall.pdf", pdf: handle },
        )}
        scope={scope()}
        onDownload={() => undefined}
      />,
    );
    await flush();
    const canvas = container.querySelector("canvas");
    // 3000 × 4000 px is 12 Mpx, so the scale is sqrt(4.8M / 12M) ≈ 0.632, not 2.
    expect(canvas?.width).toBe(Math.floor(3000 * Math.sqrt(PAGE_PIXELS_MAX / 12_000_000)));
    expect(canvas?.width).toBeLessThan(2000);
    await unmount();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  });

  it("turns a page over the image budget into the page-level too-large message", async () => {
    mocks.pageBudgetFailure.mockReturnValue(new PageFailure("image_budget_exceeded"));
    const { handle } = pdfDocument();
    const { container, unmount } = await mount(
      <PdfSurface document={pdfSurface(handle)} scope={scope()} onDownload={() => undefined} />,
    );
    await flush();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(zh("mail.attachment.previewPageTooLarge").slice(0, 4));
    expect(container.querySelector("canvas")).toBeNull();
    await unmount();
  });

  it("releases the page when the drawer unmounts", async () => {
    const { handle, pages } = pdfDocument();
    const { unmount } = await mount(
      <PdfSurface document={pdfSurface(handle)} scope={scope()} onDownload={() => undefined} />,
    );
    await flush();
    await unmount();
    await flush();
    expect(mocks.releasePdfPage).toHaveBeenCalledWith(pages[0], loadingTask, expect.objectContaining({ renderTask: expect.anything() }));
  });

  it("releases a page that resolves after the surface is gone", async () => {
    let resolvePage: (page: FakePage) => void = () => undefined;
    const pending = new Promise<FakePage>((resolve) => {
      resolvePage = resolve;
    });
    const latePage = makePage();
    const getPage = vi.fn(() => pending);
    const handle = { documentId: "pdf-test", pageCount: 1, pdf: { getPage }, loadingTask } as never;
    const { unmount } = await mount(
      <PdfSurface
        document={documentWith(
          { surface: "pdf", documentId: "pdf-test", pageCount: 1, page: 1 },
          { kind: "pdf", filename: "late.pdf", pdf: handle },
        )}
        scope={scope()}
        onDownload={() => undefined}
      />,
    );
    await unmount();
    await act(async () => {
      resolvePage(latePage);
    });
    await flush();
    expect(mocks.releasePdfPage).toHaveBeenCalledWith(latePage, loadingTask);
  });
});

const scope = () => new ResourceScope();
