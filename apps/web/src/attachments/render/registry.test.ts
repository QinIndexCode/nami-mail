import { describe, expect, it } from "vitest";
import { previewSurfaceNames } from "../catalog";
import ArchiveSurface from "./ArchiveSurface";
import FallbackSurface from "./FallbackSurface";
import ImageSurface from "./ImageSurface";
import MarkdownSurface from "./MarkdownSurface";
import MediaSurface from "./MediaSurface";
import OfficeSurface from "./OfficeSurface";
import PdfSurface from "./PdfSurface";
import TextSurface from "./TextSurface";
import { registeredSurfaces, surfaceComponentFor } from "./registry";

describe("surface registry", () => {
  it("registers all ten catalog surfaces", () => {
    expect([...registeredSurfaces].sort()).toEqual([...previewSurfaceNames].sort());
    expect(registeredSurfaces).toHaveLength(10);
  });

  it("resolves every registered surface to a component", () => {
    expect(surfaceComponentFor("text")).toBe(TextSurface);
    expect(surfaceComponentFor("markdown")).toBe(MarkdownSurface);
    expect(surfaceComponentFor("raster")).toBe(ImageSurface);
    expect(surfaceComponentFor("vector")).toBe(ImageSurface);
    expect(surfaceComponentFor("pdf")).toBe(PdfSurface);
    expect(surfaceComponentFor("media")).toBe(MediaSurface);
    expect(surfaceComponentFor("blocks")).toBe(OfficeSurface);
    expect(surfaceComponentFor("sheet")).toBe(OfficeSurface);
    expect(surfaceComponentFor("archive")).toBe(ArchiveSurface);
    expect(surfaceComponentFor("download_only")).toBe(FallbackSurface);
  });

  it("only registers names the catalog knows", () => {
    for (const name of registeredSurfaces) expect(previewSurfaceNames).toContain(name);
  });
});
