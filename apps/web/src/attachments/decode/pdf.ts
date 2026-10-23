import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  MAX_IMAGES_PER_PAGE,
  MAX_IMAGE_PIXELS_PER_PAGE,
  MAX_PAGES,
  PAGE_BYTES,
  PDF_FIRST_PAGE_MS,
  PDF_IMAGE_FILTER_BYTES,
  PDF_OPEN_DEADLINE_MS,
  canvasMaxAreaInBytes,
  maxImageSize,
} from "../budget";
import { assertSameOriginAssetUrl, type DecodeContext, type PreviewDocument, type PreviewInput } from "../document";
import { PageFailure, PreviewFailure, isAbortError } from "../failure";
import { withTimeout } from "./deadline";

// pdf.js is only ever loaded through a dynamic import: it brings its own worker
// bootstrap and roughly a megabyte of parser, and the preview drawer must not
// pay for that until a PDF is actually opened. `AnnotationMode` is materialised
// from that same module so the render layer can pass the library's own value
// without importing pdfjs-dist itself (see the eslint ban on render/**).
const pdfjs = await import("pdfjs-dist");

export const AnnotationMode = pdfjs.AnnotationMode;
export const OPS = pdfjs.OPS;

export type PdfDocumentHandle = {
  documentId: string;
  pageCount: number;
  pdf: PDFDocumentProxy;
  loadingTask: PDFDocumentLoadingTask;
};

/** Same-origin asset base; no parameter, so no input can point it elsewhere. */
export function pdfAssetBase(): string {
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  return new URL("/pdfjs/", origin).href;
}

/**
 * The document-options snapshot (plan §6.2).
 *
 * Four asset families are all derived from `pdfAssetBase()` and re-checked by
 * the invariant before use. `useWasm` is deliberately absent: closing it would
 * disable QCMS → ICC colour would silently fall back to a naive conversion.
 * `isEvalSupported` is absent because this pdf.js version has no such option —
 * asserting it in a test would be a tautology.
 */
export function buildPdfOptions() {
  const base = pdfAssetBase();
  const assetUrls = [`${base}cmaps/`, `${base}iccs/`, `${base}standard_fonts/`, `${base}wasm/`];
  for (const url of assetUrls) assertSameOriginAssetUrl(url);
  return {
    cMapUrl: assetUrls[0]!,
    cMapPacked: true,
    iccUrl: assetUrls[1]!,
    standardFontDataUrl: assetUrls[2]!,
    wasmUrl: assetUrls[3]!,
    useSystemFonts: false,
    maxImageSize,
    canvasMaxAreaInBytes,
    stopAtErrors: true,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
  };
}

let workerConfigured = false;

/**
 * Points pdf.js at our own worker bundle (same copy the Agent's file reader
 * uses). Only the first PDF pays for it; the URL is a build-time asset import
 * so the worker chunk exists in a packaged build.
 */
async function configureWorker(): Promise<void> {
  if (workerConfigured || pdfjs.GlobalWorkerOptions.workerSrc) return;
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  workerConfigured = true;
}

/** `%PDF-` may be preceded by junk (Acrobat tolerates it), but only in the first KiB. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 1024));
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let index = 0; index + marker.length <= window.length; index += 1) {
    if (marker.every((byte, offset) => window[index + offset] === byte)) return true;
  }
  return false;
}

type PageImageStats = { images: number; pixels: number };

/**
 * Sums the image work a page asks for, after pdf.js has already decoded it.
 *
 * This is damage control, not prevention: `getOperatorList()` is where inline
 * and embedded images are decoded, so by the time these numbers are known the
 * bytes are spent. The real pre-decode gate is `maxImageSize` +
 * `stopAtErrors`; this check only stops the *next* page and the next image.
 */
export function measureOperatorList(operatorList: {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}): PageImageStats {
  const seenObjectIds = new Set<string>();
  let images = 0;
  let pixels = 0;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] as unknown;
    if (operator === OPS.paintInlineImageXObject) {
      const inline = Array.isArray(args) ? (args[0] as { width?: number; height?: number } | undefined) : undefined;
      if (typeof inline?.width === "number" && typeof inline.height === "number") {
        images += 1;
        pixels += inline.width * inline.height;
      }
      continue;
    }
    if (operator !== OPS.paintImageXObject && operator !== OPS.paintImageMaskXObject) continue;
    const list = Array.isArray(args) ? args : [];
    const objectId = typeof list[0] === "string" ? list[0] : null;
    const width = typeof list[1] === "number" ? list[1] : null;
    const height = typeof list[2] === "number" ? list[2] : null;
    if (objectId !== null) {
      if (seenObjectIds.has(objectId)) continue;
      seenObjectIds.add(objectId);
    }
    images += 1;
    if (width !== null && height !== null) pixels += width * height;
  }
  return { images, pixels };
}

/** What a page asks pdf.js for; the gate itself lives in `pageBudgetFailure`. */
export async function measurePageImages(page: PDFPageProxy): Promise<PageImageStats> {
  return measureOperatorList(await page.getOperatorList());
}

export function pageBudgetFailure(stats: PageImageStats): PageFailure | null {
  if (stats.images > MAX_IMAGES_PER_PAGE) return new PageFailure("image_budget_exceeded");
  if (stats.pixels > MAX_IMAGE_PIXELS_PER_PAGE) return new PageFailure("image_budget_exceeded");
  return null;
}

async function destroyTask(loadingTask: PDFDocumentLoadingTask): Promise<void> {
  try {
    await loadingTask.destroy();
  } catch {
    // Destroying an already-failed task is best effort; the worker is going
    // away either way and a throw here would mask the failure we are reporting.
  }
}

export type PageReleaseOptions = {
  /** The active `RenderTask`, if any: cancellation is step one. */
  renderTask?: { cancel: () => Promise<void> | void } | null;
  /** Whole-document degradation must always reclaim the worker. */
  destroyTask?: boolean;
};

/**
 * The three-step release (plan §9.4): cancel the render task, retry
 * `page.cleanup()` up to three times (it can return `false` when a RenderTask
 * is still attached and then do nothing), and only destroy the loading task
 * when cleanup never succeeded — or when the whole document is being dropped.
 *
 * `cleanup()` alone would leave the worker thread and its wasm heap alive for
 * the lifetime of the process; that is why the last resort is `destroy()`.
 */
export async function releasePdfPage(
  page: PDFPageProxy | null,
  loadingTask: PDFDocumentLoadingTask,
  options: PageReleaseOptions = {},
): Promise<void> {
  const { renderTask = null, destroyTask: dropDocument = false } = options;
  if (renderTask) {
    try {
      await renderTask.cancel();
    } catch {
      // A finished RenderTask rejects cancel(); nothing left to cancel.
    }
  }
  let cleaned = page === null;
  if (page) {
    for (let attempt = 0; attempt < 3 && !cleaned; attempt += 1) {
      try {
        cleaned = page.cleanup();
      } catch {
        cleaned = false;
      }
    }
  }
  if (dropDocument || !cleaned) await destroyTask(loadingTask);
}

function classifyOpenError(error: unknown): unknown {
  const name = (error as { name?: string } | null)?.name;
  const message = (error as { message?: string } | null)?.message ?? "";
  if (name === "PasswordException") return new PreviewFailure("encrypted", { cause: error });
  if (name === "InvalidPDFException") return new PreviewFailure("corrupt", { cause: error });
  if (message.includes("Image exceeded maximum allowed size")) {
    return new PreviewFailure("image_budget_exceeded", { cause: error });
  }
  return error;
}

/**
 * Loads a PDF and proves the first page is within budget; rendering is the
 * surface's job.
 *
 * `getDocument({ data })` transfers the buffer to the worker, so `input.bytes`
 * is unusable afterwards — retry and page turns must re-take the bytes.
 */
export async function decodePdf(input: PreviewInput, ctx: DecodeContext): Promise<PreviewDocument> {
  if (!hasPdfMagic(input.bytes)) throw new PreviewFailure("corrupt");
  await configureWorker();

  const loadingTask = pdfjs.getDocument({ data: input.bytes, ...buildPdfOptions() });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await withTimeout(loadingTask.promise, PDF_OPEN_DEADLINE_MS, () => {
      void destroyTask(loadingTask);
    }, { signal: ctx.signal });
  } catch (error) {
    if (isAbortError(error)) {
      await destroyTask(loadingTask);
      throw error;
    }
    if (error instanceof PreviewFailure && error.code === "timeout") throw error;
    throw classifyOpenError(error);
  }

  if (pdf.numPages > MAX_PAGES) {
    await destroyTask(loadingTask);
    throw new PreviewFailure("too_many_pages");
  }

  let firstPage: PDFPageProxy | null = null;
  try {
    firstPage = await withTimeout(pdf.getPage(1), PDF_FIRST_PAGE_MS, () => {
      void destroyTask(loadingTask);
    }, { signal: ctx.signal });
    const stats = await withTimeout(measurePageImages(firstPage), PDF_FIRST_PAGE_MS, () => {
      void destroyTask(loadingTask);
    }, { signal: ctx.signal });
    const overBudget = pageBudgetFailure(stats);
    if (overBudget) throw overBudget;
  } catch (error) {
    // A first page that cannot stay inside the image budget degrades the whole
    // document to a visible "too large" state — never a blank page. The page is
    // released, and the worker goes with it (task.destroy exactly once).
    await releasePdfPage(firstPage, loadingTask, {
      destroyTask: error instanceof PageFailure,
    });
    if (error instanceof PageFailure) {
      throw new PreviewFailure("image_budget_exceeded", { cause: error });
    }
    if (error instanceof PreviewFailure) {
      if (error.code === "timeout") throw error;
      throw new PreviewFailure("corrupt", { cause: error });
    }
    if (isAbortError(error)) throw error;
    throw classifyOpenError(error);
  }
  // The operator list we just measured has served its purpose; dropping it
  // keeps the page cache at one canvas instead of one per page turn.
  if (firstPage) firstPage.cleanup();

  ctx.lease.charge(PAGE_BYTES + PDF_IMAGE_FILTER_BYTES, "pdf page canvas and image decode");

  const documentId = `pdf-${crypto.randomUUID()}`;
  return {
    kind: "pdf",
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    surface: { surface: "pdf", documentId, pageCount: pdf.numPages, page: 1 },
    pdf: { documentId, pageCount: pdf.numPages, pdf, loadingTask },
  };
}
