import type { MessageAttachment } from "./types";

/**
 * Web-side companion to the server backup zipper: bundles the visible
 * attachments of one message into a single zip in the browser. Sources are
 * fetched on demand through the caller-provided blob fetch, mirroring the
 * per-attachment download path.
 */

/** Mangles a filename into a safe zip entry name (no separators or control chars). */
export function attachmentZipEntryName(filename: string, index: number): string {
  const cleaned = filename
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `${String(index).padStart(3, "0")}_${cleaned || "attachment"}`;
}

/** Derives the download filename from a message subject. */
export function attachmentsZipFilename(subject: string): string {
  const cleaned = subject
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 60)
    .trim();
  return `${cleaned || "attachments"}.zip`;
}

/**
 * Downloads every attachment through `fetchBlob` and composes them into one
 * zip blob. Entry names carry the position index, so same-named attachments
 * never collide inside the archive.
 */
export async function buildAttachmentsZipBlob(
  attachments: readonly MessageAttachment[],
  fetchBlob: (partId: string) => Promise<Blob>,
): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const [index, attachment] of attachments.entries()) {
    zip.file(attachmentZipEntryName(attachment.filename, index), fetchBlob(attachment.partId).then((blob) => blob.arrayBuffer()));
  }
  return zip.generateAsync({ type: "blob" });
}

/** Triggers a browser download for an in-memory blob. */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
}