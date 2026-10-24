import { useState } from "react";
import { asDownloadOnly, type SurfaceProps } from "../document";
import FallbackSurface from "./FallbackSurface";

/**
 * Audio and video: the element is the decoder.
 *
 * No `autoPlay`, no `<source>` list, no `crossOrigin`, no captions track: this
 * surface may not start playback, may not issue a second request, and may not
 * read the media's bytes itself. A container the browser refuses turns into the
 * download card with reason `unsupported` — the honest answer, since the format
 * was classified correctly but has no player here.
 */
export default function MediaSurface({ document, onDownload }: SurfaceProps) {
  const [failed, setFailed] = useState(false);
  const surface = document.surface;
  if (surface.surface !== "media") return null;
  if (failed) {
    return <FallbackSurface document={asDownloadOnly(document, "unsupported")} onDownload={onDownload} />;
  }
  const shared = {
    className: "attachment-preview-media",
    src: surface.url,
    controls: true,
    preload: "metadata",
    "aria-label": surface.filename,
    onError: () => setFailed(true),
  } as const;
  return (
    <div className="attachment-preview-media-wrap" data-media-kind={surface.mediaKind}>
      {surface.mediaKind === "audio" ? <audio {...shared} /> : <video {...shared} playsInline />}
    </div>
  );
}
