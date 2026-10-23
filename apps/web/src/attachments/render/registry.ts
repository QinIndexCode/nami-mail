import type { ComponentType } from "react";
import type { SurfaceName, SurfaceProps } from "../document";
import FallbackSurface from "./FallbackSurface";
import ImageSurface from "./ImageSurface";
import MediaSurface from "./MediaSurface";
import PdfSurface from "./PdfSurface";
import TextSurface from "./TextSurface";

/**
 * Surface → component. S2 registers the six surfaces it can render and leaves
 * the rest to the fallback card; S3 fills the table to all ten and drops the
 * fallback.
 *
 * `raster` and `vector` deliberately share `ImageSurface`: the difference is a
 * data attribute, not a second implementation.
 */
const partialSurfaces: Partial<Record<SurfaceName, ComponentType<SurfaceProps>>> = {
  text: TextSurface,
  raster: ImageSurface,
  vector: ImageSurface,
  pdf: PdfSurface,
  media: MediaSurface,
  download_only: FallbackSurface,
};

/** The surfaces this build can actually render. */
export const registeredSurfaces = Object.keys(partialSurfaces) as SurfaceName[];

export function surfaceComponentFor(name: SurfaceName): ComponentType<SurfaceProps> {
  return partialSurfaces[name] ?? FallbackSurface;
}
