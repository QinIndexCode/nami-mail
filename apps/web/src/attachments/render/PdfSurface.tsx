import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { PAGE_PIXELS_MAX, PDF_PAGE_MS } from "../budget";
import { sanitizeDisplayName } from "../catalog";
import { AnnotationMode, measureOperatorList, pageBudgetFailure, releasePdfPage, withTimeout } from "../decode";
import type { SurfaceProps } from "../document";
import { PageFailure, PreviewFailure, failurePresentation, pageFailureCodes, type PageFailureCode } from "../failure";

type RenderTaskLike = { cancel: () => void; promise: Promise<unknown> };

/**
 * PDF: one canvas, one render scale for the whole document, page turning inside
 * the surface.
 *
 * The scale is capped by the pixel budget rather than the CSS width, so a wide
 * drawer cannot push a page canvas past `PAGE_PIXELS_MAX` (and past the
 * `PAGE_BYTES` charge the ledger already took). It is computed once per
 * document: a per-page scale would make the ledger and the actual canvas sizes
 * disagree.
 *
 * Release order on every page change and on unmount is
 * `renderTask.cancel()` → `page.cleanup()` retries → `loadingTask.destroy()`
 * (only if all three cleanups fail); `cleanup()` can legitimately return false
 * while a render task is still attached, which is why it is retried.
 */
export default function PdfSurface({ document, onDownload }: SurfaceProps) {
  const { t } = useI18n();
  const surface = document.surface;
  const handle = document.pdf;
  const [page, setPage] = useState(surface.surface === "pdf" ? surface.page : 1);
  const [failure, setFailure] = useState<PageFailureCode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scaleRef = useRef<{ documentId: string; scale: number } | null>(null);

  const pageCount = surface.surface === "pdf" ? surface.pageCount : 0;
  // Scalars, not the surface object: a parent that rebuilds the document on a
  // resize must not force a full re-render of the same page.
  const documentId = surface.surface === "pdf" ? surface.documentId : "";

  useEffect(() => {
    setFailure(null);
    if (!handle || documentId === "") return undefined;
    const { pdf, loadingTask } = handle;
    let disposed = false;
    // Set when this attempt is finished for good (timeout, error, teardown).
    // A `getPage()` that times out can still resolve later, and that late page
    // would otherwise never be released.
    let abandoned = false;
    let pageProxy: Awaited<ReturnType<typeof pdf.getPage>> | null = null;
    let renderTask: RenderTaskLike | null = null;
    const release = (task: RenderTaskLike | null) => {
      if (!pageProxy) return;
      const target = pageProxy;
      pageProxy = null;
      void releasePdfPage(target, loadingTask, { renderTask: task });
    };

    const run = async () => {
      try {
        const pendingPage = pdf.getPage(page);
        pendingPage.then(
          (late) => {
            if (abandoned) void releasePdfPage(late, loadingTask);
          },
          () => undefined,
        );
        const proxy = await withTimeout(pendingPage, PDF_PAGE_MS, () => undefined);
        if (abandoned) return;
        pageProxy = proxy;
        const base = proxy.getViewport({ scale: 1 });
        if (!scaleRef.current || scaleRef.current.documentId !== documentId) {
          const devicePixelRatio = typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
          const budgetScale = Math.sqrt(PAGE_PIXELS_MAX / Math.max(1, base.width * base.height));
          scaleRef.current = { documentId, scale: Math.min(devicePixelRatio, budgetScale) };
        }
        const viewport = proxy.getViewport({ scale: scaleRef.current.scale });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d") ?? null;
        if (!canvas || !context) throw new PageFailure("corrupt");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const task = proxy.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.DISABLE }) as RenderTaskLike;
        renderTask = task;
        // `getOperatorList()` is where inline images are decoded, so it shares
        // the page budget with the render itself.
        const operatorList = await withTimeout(proxy.getOperatorList(), PDF_PAGE_MS, () => {
          void task.cancel();
          proxy.cleanup();
        });
        // Page 1 was measured during decode; later pages are measured here, so a
        // page that asks for four images fails the same way page 1 would.
        const budget = pageBudgetFailure(measureOperatorList(operatorList));
        if (budget) {
          void task.cancel();
          throw budget;
        }
        await withTimeout(task.promise, PDF_PAGE_MS, () => {
          void task.cancel();
          proxy.cleanup();
        });
      } catch (error) {
        if (disposed) return;
        abandoned = true;
        release(renderTask);
        // A page can only fail in four ways; anything else is reported as
        // `corrupt`, which is the closest honest code a single page can carry.
        if (error instanceof PageFailure) setFailure(error.code);
        else if (error instanceof PreviewFailure && (pageFailureCodes as readonly string[]).includes(error.code)) {
          setFailure(error.code as PageFailureCode);
        } else setFailure("corrupt");
      }
    };

    void run();
    return () => {
      disposed = true;
      abandoned = true;
      release(renderTask);
    };
  }, [handle, page, pageCount, documentId]);

  if (surface.surface !== "pdf") return null;

  const presentation = failure ? failurePresentation(failure) : null;
  return (
    <div className="attachment-preview-pdf">
      <div className="attachment-preview-pdf-toolbar">
        <button
          type="button"
          className="attachment-preview-page-nav"
          aria-label={t("mail.attachment.previewPrevPage")}
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <p className="attachment-preview-pdf-page-label">
          {t("mail.attachment.previewPageOf", { page, total: pageCount })}
        </p>
        <button
          type="button"
          className="attachment-preview-page-nav"
          aria-label={t("mail.attachment.previewNextPage")}
          disabled={page >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <button type="button" className="attachment-preview-download" onClick={onDownload}>
          <Download size={14} aria-hidden="true" />
          {t("mail.attachment.previewDownloadOnly")}
        </button>
      </div>
      {presentation ? (
        <p className="attachment-preview-page-failure" role="status">
          {t(presentation.messageKey, { seconds: Math.round(PDF_PAGE_MS / 1000), max: String(PAGE_PIXELS_MAX) })}
        </p>
      ) : (
        <div className="attachment-preview-pdf-canvas attachment-preview-scroll">
          <canvas
            ref={canvasRef}
            className="attachment-preview-page"
            role="img"
            aria-label={t("mail.attachment.preview", { filename: sanitizeDisplayName(document.filename) })}
          />
        </div>
      )}
    </div>
  );
}
