// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { documentWith, flush, markup, mount, zh } from "../testing/surfaceHarness";
import FallbackSurface from "./FallbackSurface";


const downloadOnly = (reason: "unsupported" | "mime" | "size" | "encrypted") =>
  documentWith({ surface: "download_only", reason, messageKey: "mail.attachment.previewDownloadOnly" });

describe("FallbackSurface", () => {
  it("explains an unsupported file with the second line", () => {
    const html = markup(<FallbackSurface document={downloadOnly("unsupported")} onDownload={() => undefined} />);
    expect(html).toContain(zh("mail.attachment.previewDownloadOnly"));
    expect(html).toContain(zh("mail.attachment.previewUnsupported"));
  });

  it("uses a different second line when the bytes disagree with the extension", () => {
    const html = markup(<FallbackSurface document={downloadOnly("mime")} onDownload={() => undefined} />);
    expect(html).toContain(zh("mail.attachment.previewKindMismatch"));
    expect(html).not.toContain(zh("mail.attachment.previewUnsupported"));
  });

  it("keeps size and encryption to the primary line only", () => {
    for (const reason of ["size", "encrypted"] as const) {
      const html = markup(<FallbackSurface document={downloadOnly(reason)} onDownload={() => undefined} />);
      expect(html).toContain(zh("mail.attachment.previewDownloadOnly"));
      expect(html).not.toContain(zh("mail.attachment.previewUnsupported"));
      expect(html).not.toContain(zh("mail.attachment.previewKindMismatch"));
    }
  });

  it("downloads through the drawer's handler, with the filename sanitized", async () => {
    const handled = vi.fn();
    const { container, unmount } = await mount(
      <FallbackSurface
        document={{ ...downloadOnly("size"), filename: "evil\u0000name.pdf" }}
        onDownload={handled}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.textContent).not.toContain("\u0000");
    await act(async () => button?.click());
    await flush();
    expect(handled).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
