import type { MemoryLease } from "./budget";
import type { PreviewKind, PreviewSurfaceName } from "./catalog";
import type { PdfDocumentHandle } from "./decode/pdf";

/**
 * The data contract between decode and render (plan §7).
 *
 * Two rules make the boundary worth a module: renderer components never fetch
 * or decode (they receive a finished document), and every object URL is owned
 * by the `ResourceScope` the drawer creates — so "who revokes this?" has one
 * answer instead of one per surface.
 */

export type Block = { text: string };

export type Sheet = { name: string; rows: string[][] };

export type ArchiveEntry = { path: string; bytes: number };

export type DownloadOnlyReason = "unsupported" | "mime" | "encrypted" | "size";

export type PreviewSurface =
  | { surface: "text"; text: string; shown: number; total: number }
  | { surface: "markdown"; text: string; shown: number; total: number }
  | { surface: "raster"; url: string; width: number; height: number; alt: string }
  | { surface: "vector"; url: string; width: number; height: number }
  | { surface: "pdf"; documentId: string; pageCount: number; page: number }
  | { surface: "media"; url: string; mediaKind: "audio" | "video"; filename: string }
  | { surface: "blocks"; blocks: Block[] }
  | { surface: "sheet"; sheets: Sheet[] }
  | { surface: "archive"; entries: ArchiveEntry[]; declaredBytes: number }
  | { surface: "download_only"; reason: DownloadOnlyReason; messageKey: string };

export type PreviewDocument = {
  kind: PreviewKind;
  filename: string;
  contentType: string;
  size: number;
  surface: PreviewSurface;
  /**
   * The loaded pdf.js document, for the one surface that needs the live proxy
   * (page turning). Kept beside `surface` because `PreviewSurface` stays a
   * serialisable description — the proxy has methods, not fields.
   */
  pdf?: PdfDocumentHandle;
};

export type SurfaceProps = {
  document: PreviewDocument;
  onDownload: () => void;
};

/** What ingress hands to the decoder: the classified input plus its bytes. */
export type PreviewInput = {
  kind: PreviewKind;
  filename: string;
  contentType: string;
  size: number;
  bytes: Uint8Array<ArrayBuffer>;
  /**
   * The same bytes as a Blob. Media surfaces hand this to `URL.createObjectURL`
   * instead of re-wrapping the bytes themselves: creating an object URL is the
   * scope's job, and one copy of the payload is enough.
   */
  blob: Blob;
};

/**
 * Everything a decoder is allowed to touch besides its input.
 *
 * The clock is injected (`now`) so the cooperative deadline can be tested with
 * fake timers, and `signal` is the only cancellation channel — a decoder may
 * check it between chunks, which is all this architecture promises (a single
 * `parseFromString` is not interruptible).
 */
export type DecodeContext = {
  scope: ResourceScope;
  lease: MemoryLease;
  signal: AbortSignal;
  now: () => number;
  deadlineMs: number;
};

/** The surface table's key set — the 10 `PreviewSurfaceName`s from the catalog. */
export type SurfaceName = PreviewSurfaceName;

/** Used by every `download_only` producer; the four reasons share one primary key. */
export const downloadOnlyMessageKey = "mail.attachment.previewDownloadOnly";

export function downloadOnlySurface(reason: DownloadOnlyReason): PreviewSurface {
  return { surface: "download_only", reason, messageKey: downloadOnlyMessageKey };
}

/** Re-wraps a decoded document as "not previewable here" without losing its identity. */
export function asDownloadOnly(document: PreviewDocument, reason: DownloadOnlyReason): PreviewDocument {
  return { ...document, surface: downloadOnlySurface(reason) };
}

type OwnedResource = { kind: string; value: unknown; dispose: (value: unknown) => void };

/**
 * Owns everything the drawer must release, in LIFO order.
 *
 * LIFO matters for the PDF case: a page canvas registered after the loading
 * task must be released before the task is destroyed, otherwise pdf.js logs
 * "cannot use a detached ArrayBuffer" style errors on teardown.
 */
export class ResourceScope {
  private resources: OwnedResource[] = [];
  private released = false;

  get disposed(): boolean {
    return this.released;
  }

  own<T>(kind: string, value: T, dispose: (value: T) => void): T {
    if (this.released) {
      // Registering into a dead scope is a bug, but leaking the resource would
      // be worse than a synchronous revoke: release it now and keep going.
      dispose(value);
      return value;
    }
    this.resources.push({ kind, value, dispose: dispose as (value: unknown) => void });
    return value;
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    const pending = this.resources;
    this.resources = [];
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const resource = pending[index]!;
      try {
        resource.dispose(resource.value);
      } catch {
        // A failing disposer must not strand the rest — especially the PDF
        // loading task, which is the one thing that keeps a worker alive.
      }
    }
  }
}

/**
 * The only supported way to mint a preview object URL.
 *
 * Ownership and creation live together on purpose: a decoder that creates its
 * own URL can forget to revoke it, whereas a URL that comes out of here is
 * already registered in the scope, so `scope.dispose()` is the single release
 * path and the lint rule can keep `URL.createObjectURL` inside this module.
 */
export function ownObjectUrl(scope: ResourceScope, blob: Blob, kind = "object-url"): string {
  return scope.own(kind, URL.createObjectURL(blob), (url) => URL.revokeObjectURL(url));
}

/**
 * Programming/config invariant, not an input-driven failure: `pdfAssetBase()`
 * takes no argument and is derived from `location.origin`, so no incoming file
 * can break this. It exists so that anyone who later parameterises the base
 * hits a plain `Error` (no failure code, nothing user-facing) instead of a
 * cross-origin script load.
 */
export function assertSameOriginAssetUrl(url: string): void {
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const parsed = new URL(url, origin);
  if (parsed.origin !== origin) throw new Error(`pdf.js asset URL must be same-origin: ${url}`);
  if (!parsed.pathname.startsWith("/pdfjs/")) throw new Error(`pdf.js asset URL must live under /pdfjs/: ${url}`);
}
