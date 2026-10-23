import type { ComponentType } from "react";
import type { SurfaceName, SurfaceProps } from "../document";
import ArchiveSurface from "./ArchiveSurface";
import FallbackSurface from "./FallbackSurface";
import ImageSurface from "./ImageSurface";
import MarkdownSurface from "./MarkdownSurface";
import MediaSurface from "./MediaSurface";
import OfficeSurface from "./OfficeSurface";
import PdfSurface from "./PdfSurface";
import TextSurface from "./TextSurface";

/**
 * Surface → component, exhaustive over the catalog's ten names.
 *
 * The table is a `Record`, not a `Partial`, so adding an eleventh surface to the
 * catalog fails to compile until a component exists for it. There is no
 * fallback branch left: `download_only` is a real surface with a real card, and
 * a missing entry is a type error rather than a blank pane at runtime.
 *
 * `raster` and `vector` deliberately share `ImageSurface`: the difference is a
 * data attribute, not a second implementation.
 */
const surfaces: Record<SurfaceName, ComponentType<SurfaceProps>> = {
  text: TextSurface,
  markdown: MarkdownSurface,
  raster: ImageSurface,
  vector: ImageSurface,
  pdf: PdfSurface,
  media: MediaSurface,
  blocks: OfficeSurface,
  sheet: OfficeSurface,
  archive: ArchiveSurface,
  download_only: FallbackSurface,
};

/** The surfaces this build can render. */
export const registeredSurfaces = Object.keys(surfaces) as SurfaceName[];

export function surfaceComponentFor(name: SurfaceName): ComponentType<SurfaceProps> {
  return surfaces[name];
}
