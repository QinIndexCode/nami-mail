// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentZipEntryName,
  attachmentsZipFilename,
  buildAttachmentsZipBlob,
  triggerBlobDownload,
} from "./attachmentZip";
import type { MessageAttachment } from "./types";

function attachment(partId: string, filename: string, contentType = "application/octet-stream"): MessageAttachment {
  return { partId, filename, contentType, size: 0, related: false, disposition: "attachment" as const };
}

describe("attachmentZipEntryName", () => {
  it("keeps a plain filename with its index prefix", () => {
    expect(attachmentZipEntryName("report.pdf", 0)).toBe("000_report.pdf");
    expect(attachmentZipEntryName("photo (1).jpg", 2)).toBe("002_photo (1).jpg");
  });

  it("mangles separators and control characters", () => {
    expect(attachmentZipEntryName("a/b\\c:d*e?f\"g<h>i|j", 1)).toBe("001_a b c d e f g h i j");
    expect(attachmentZipEntryName("line\nbreak", 3)).toBe("003_line break");
  });

  it("falls back for empty names", () => {
    expect(attachmentZipEntryName("   ", 0)).toBe("000_attachment");
  });
});

describe("attachmentsZipFilename", () => {
  it("derives a safe zip name from the subject", () => {
    expect(attachmentsZipFilename("Quarterly report")).toBe("Quarterly report.zip");
    expect(attachmentsZipFilename("a/b:c")).toBe("a b c.zip");
    expect(attachmentsZipFilename("   ")).toBe("attachments.zip");
  });
});

describe("buildAttachmentsZipBlob", () => {
  it("composes every fetched attachment into one zip, preserving contents", async () => {
    const contents: Record<string, string> = { "part-1": "hello pdf", "part-2": "hello txt" };
    const blob = await buildAttachmentsZipBlob(
      [attachment("part-1", "report.pdf", "application/pdf"), attachment("part-2", "notes.txt", "text/plain")],
      async (partId) => new Blob([contents[partId]]),
    );
    expect(blob instanceof Blob).toBe(true);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["000_report.pdf", "001_notes.txt"]);
    expect(await zip.file("000_report.pdf")?.async("text")).toBe("hello pdf");
    expect(await zip.file("001_notes.txt")?.async("text")).toBe("hello txt");
  });

  it("keeps same-named attachments distinct via their index prefix", async () => {
    const blob = await buildAttachmentsZipBlob(
      [attachment("part-1", "report.pdf"), attachment("part-2", "report.pdf")],
      async (partId) => new Blob([partId]),
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["000_report.pdf", "001_report.pdf"]);
  });

  it("fails the zip when a fetch rejects", async () => {
    await expect(
      buildAttachmentsZipBlob([attachment("part-1", "report.pdf")], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("triggerBlobDownload", () => {
  it("clicks a temporary anchor and revokes the object URL", () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      triggerBlobDownload(new Blob(["x"]), "attachments.zip");
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      const anchor = click.mock.instances[0] as HTMLAnchorElement | undefined;
      expect(anchor?.download).toBe("attachments.zip");
      expect(anchor?.href).toBe("blob:fake");
      vi.advanceTimersByTime(1_000);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      vi.useRealTimers();
      click.mockRestore();
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });
});