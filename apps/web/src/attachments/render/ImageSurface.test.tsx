// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ResourceScope } from "../document";
import { documentWith, flush, markup, mount, zh } from "../testing/surfaceHarness";
import ImageSurface from "./ImageSurface";

const scope = new ResourceScope();
const onDownload = () => undefined;

describe("ImageSurface", () => {
  it("renders a raster image at its intrinsic size with the sanitized alt", () => {
    const html = markup(
      <ImageSurface
        document={documentWith({
          surface: "raster",
          url: "blob:app/1",
          width: 640,
          height: 480,
          alt: "photo.png",
        })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain('src="blob:app/1"');
    expect(html).toContain('width="640"');
    expect(html).toContain('height="480"');
    expect(html).toContain('alt="photo.png"');
    expect(html).toContain('data-surface="raster"');
  });

  it("uses the filename as alt for a vector surface", () => {
    const html = markup(
      <ImageSurface
        document={documentWith(
          { surface: "vector", url: "blob:app/2", width: 300, height: 150 },
          { kind: "image-vector", filename: "logo.svg", contentType: "image/svg+xml" },
        )}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain('alt="logo.svg"');
    expect(html).toContain('data-surface="vector"');
  });

  it("replaces a browser decode failure with the corrupt card", async () => {
    const { container, unmount } = await mount(
      <ImageSurface
        document={documentWith({ surface: "raster", url: "blob:app/3", width: 10, height: 10, alt: "x.png" })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });
    await flush();
    expect(container.textContent).toContain(zh("mail.attachment.previewCorrupt"));
    expect(container.querySelector("img")).toBeNull();
    container.querySelector("button")?.click();
    await unmount();
  });

  it("offers the download card from the failed state", async () => {
    const handled = vi.fn();
    const { container, unmount } = await mount(
      <ImageSurface
        document={documentWith({ surface: "raster", url: "blob:app/4", width: 10, height: 10, alt: "x.png" })}
        scope={scope}
        onDownload={handled}
      />,
    );
    const img = container.querySelector("img");
    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });
    await flush();
    const button = container.querySelector("button");
    expect(button?.textContent).toContain(zh("mail.attachment.download", { filename: "notes.txt" }));
    expect(container.textContent).not.toContain(zh("mail.attachment.previewDownloadOnly"));
    await act(async () => button?.click());
    expect(handled).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
