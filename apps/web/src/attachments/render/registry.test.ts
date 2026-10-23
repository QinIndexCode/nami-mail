import { describe, expect, it } from "vitest";
import { previewSurfaceNames } from "../catalog";
import FallbackSurface from "./FallbackSurface";
import ImageSurface from "./ImageSurface";
import MediaSurface from "./MediaSurface";
import PdfSurface from "./PdfSurface";
import TextSurface from "./TextSurface";
import { registeredSurfaces, surfaceComponentFor } from "./registry";

describe("surface registry", () => {
  it("registers exactly the S2 surface set, in catalog order", () => {
    expect(registeredSurfaces).toEqual(["text", "raster", "vector", "pdf", "media", "download_only"]);
  });

  it("resolves every registered surface to a component", () => {
    expect(surfaceComponentFor("text")).toBe(TextSurface);
    expect(surfaceComponentFor("raster")).toBe(ImageSurface);
    expect(surfaceComponentFor("vector")).toBe(ImageSurface);
    expect(surfaceComponentFor("pdf")).toBe(PdfSurface);
    expect(surfaceComponentFor("media")).toBe(MediaSurface);
    expect(surfaceComponentFor("download_only")).toBe(FallbackSurface);
  });

  it("falls back for the surfaces S3 owns instead of rendering nothing", () => {
    for (const name of ["markdown", "blocks", "sheet", "archive"] as const) {
      expect(previewSurfaceNames).toContain(name);
      expect(surfaceComponentFor(name)).toBe(FallbackSurface);
    }
  });

  it("only registers names the catalog knows", () => {
    for (const name of registeredSurfaces) expect(previewSurfaceNames).toContain(name);
  });
});
