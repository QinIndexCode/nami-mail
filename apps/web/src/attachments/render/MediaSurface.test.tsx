// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ResourceScope } from "../document";
import { documentWith, flush, markup, mount, zh } from "../testing/surfaceHarness";
import MediaSurface from "./MediaSurface";

const scope = new ResourceScope();
const onDownload = () => undefined;

describe("MediaSurface", () => {
  it("renders an audio element that loads metadata but never starts itself", () => {
    const html = markup(
      <MediaSurface
        document={documentWith(
          { surface: "media", url: "blob:app/a", mediaKind: "audio", filename: "voice.mp3" },
          { kind: "media-audio", filename: "voice.mp3", contentType: "audio/mpeg", size: 1024 },
        )}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain("<audio");
    expect(html).toContain('src="blob:app/a"');
    expect(html).toContain('controls=""');
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('aria-label="voice.mp3"');
    expect(html).toContain('data-media-kind="audio"');
    // `autoplay` must be absent, not `autoplay="false"`: React writes the
    // attribute only when the prop is true.
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("<source");
    expect(html).not.toContain("<track");
    expect(html).not.toMatch(/crossorigin/i);
  });

  it("renders video inline with the same loading policy", () => {
    const html = markup(
      <MediaSurface
        document={documentWith(
          { surface: "media", url: "blob:app/v", mediaKind: "video", filename: "clip.mp4" },
          { kind: "media-video", filename: "clip.mp4", contentType: "video/mp4", size: 1024 },
        )}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain("<video");
    expect(html.toLowerCase()).toContain("playsinline");
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("<source");
    expect(html).not.toContain("<track");
    expect(html).not.toMatch(/crossorigin/i);
  });

  it("swaps to the download card when the browser refuses the container", async () => {
    const onFallback = vi.fn();
    const { container, unmount } = await mount(
      <MediaSurface
        document={documentWith(
          { surface: "media", url: "blob:app/a", mediaKind: "audio", filename: "voice.opus" },
          { kind: "media-audio", filename: "voice.opus", contentType: "audio/opus", size: 1024 },
        )}
        scope={scope}
        onDownload={onDownload}
        onFallback={onFallback}
      />,
    );
    const element = container.querySelector("audio");
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new Event("error"));
    });
    await flush();
    expect(onFallback).toHaveBeenCalledWith("unsupported");
    expect(container.textContent).toContain(zh("mail.attachment.previewUnsupported"));
    expect(container.querySelector("audio")).toBeNull();
    await unmount();
  });

  it("does not own the object URL: the scope revokes it exactly once on unmount", async () => {
    // The surface must never call createObjectURL/revokeObjectURL itself; the
    // URL lives in the attempt's ResourceScope so a retry cannot leak a second
    // copy of the whole media file.
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const mediaScope = new ResourceScope();
    const url = mediaScope.own("object-url", "blob:app/owned", (value) => URL.revokeObjectURL(value));
    const { unmount } = await mount(
      <MediaSurface
        document={documentWith(
          { surface: "media", url, mediaKind: "audio", filename: "voice.ogg" },
          { kind: "media-audio", filename: "voice.ogg", contentType: "audio/ogg", size: 4 },
        )}
        scope={mediaScope}
        onDownload={onDownload}
      />,
    );
    await unmount();
    expect(revoke).not.toHaveBeenCalled();
    mediaScope.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });

  it("renders nothing for a document that is not media", () => {
    expect(
      markup(
        <MediaSurface
          document={documentWith({ surface: "text", text: "x", shown: 1, total: 1 })}
          scope={scope}
          onDownload={onDownload}
        />,
      ),
    ).toBe("");
  });
});
