import DOMPurify from "dompurify";
import { MAX_PAGE_PIXELS } from "../budget";
import { sanitizeDisplayName } from "../catalog";
import { ownObjectUrl, type DecodeContext, type PreviewDocument, type PreviewInput } from "../document";
import { PreviewFailure } from "../failure";

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg";

export type SniffedImage = { format: ImageFormat; width: number; height: number };

/** Declared viewBox fallback for an SVG that states no size anywhere. */
export const DEFAULT_SVG_SIZE = { width: 300, height: 150 } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_SIGNATURES = ["GIF87a", "GIF89a"];
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  if (offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
};

const u16be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
const u16le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
const u32be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
const u32le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 3] ?? 0) * 0x1000000);
const u24le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
const i32le = (bytes: Uint8Array, offset: number): number => {
  const value = u32le(bytes, offset);
  return value >= 0x80000000 ? value - 0x100000000 : value;
};

/** JPEG has no header size field: walk the segment chain to the first SOFn. */
function sniffJpeg(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function sniffWebp(bytes: Uint8Array): { width: number; height: number } | null {
  if (ascii(bytes, 12, 4) === "VP8X") {
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }
  if (ascii(bytes, 12, 4) === "VP8L") {
    const b = bytes[21] ?? 0;
    const c = bytes[22] ?? 0;
    const d = bytes[23] ?? 0;
    const e = bytes[24] ?? 0;
    const width = 1 + (((b | (c << 8)) & 0x3fff));
    const height = 1 + (((c >> 6) | (d << 2) | (e << 10)) & 0x3fff);
    return { width, height };
  }
  // Lossy VP8 key frame: 3-byte frame tag, then the 3-byte start code, then
  // two 16-bit little-endian dimensions with a 2-bit scale field on top.
  if (ascii(bytes, 12, 4) === "VP8 ") {
    const offset = 26;
    if (bytes[offset] !== 0x9d || bytes[offset + 1] !== 0x01 || bytes[offset + 2] !== 0x2a) return null;
    return { width: u16le(bytes, offset + 3) & 0x3fff, height: u16le(bytes, offset + 5) & 0x3fff };
  }
  return null;
}

/** AVIF keeps its real dimensions in an `ispe` box, not in `ftyp`. */
function sniffAvif(bytes: Uint8Array): { width: number; height: number } | null {
  for (let offset = 0; offset + 16 <= bytes.length; offset += 1) {
    if (ascii(bytes, offset, 4) !== "ispe") continue;
    // 4-byte size precedes the box type, then version/flags, then width/height.
    return { width: u32be(bytes, offset + 8), height: u32be(bytes, offset + 12) };
  }
  return null;
}

function sniffSvg(bytes: Uint8Array): { width: number; height: number } | null {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const trimmed = head.replace(/^\uFEFF/, "").trimStart();
  if (!/<svg[\s>]/i.test(trimmed)) return null;
  return readSvgSize(trimmed);
}

function parseLength(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function readSvgSize(source: string): { width: number; height: number } | null {
  const svgTag = /<svg\b[^>]*>/i.exec(source);
  if (!svgTag) return null;
  const attribute = (name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(svgTag[0])?.[1];
  const width = parseLength(attribute("width"));
  const height = parseLength(attribute("height"));
  if (width !== null || height !== null) {
    // One declared axis is enough: the other gets the documented fallback
    // rather than throwing away a size the file already stated.
    return { width: width ?? DEFAULT_SVG_SIZE.width, height: height ?? DEFAULT_SVG_SIZE.height };
  }
  const viewBox = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value))) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  // An SVG may legitimately state no size at all; rendering at the declared
  // default keeps it previewable instead of calling it corrupt.
  return { ...DEFAULT_SVG_SIZE };
}

/** Reads the intrinsic size straight from the header of the six formats the
 * catalog calls raster, plus SVG. Returns `null` when the bytes are not one of
 * them. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return { format: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (GIF_SIGNATURES.includes(ascii(bytes, 0, 6))) {
    return { format: "gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const size = sniffJpeg(bytes);
    return size ? { format: "jpeg", ...size } : null;
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const size = sniffWebp(bytes);
    return size ? { format: "webp", ...size } : null;
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    // biHeight is signed: negative means a top-down bitmap, so take the magnitude.
    return { format: "bmp", width: i32le(bytes, 18), height: i32le(bytes, 22) };
  }
  if (ascii(bytes, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 4))) {
    const size = sniffAvif(bytes);
    return size ? { format: "avif", ...size } : null;
  }
  const svg = sniffSvg(bytes);
  return svg ? { format: "svg", ...svg } : null;
}

function requireSize(image: SniffedImage): { width: number; height: number } {
  // Every length field is normalised through abs(): a negative BMP height is a
  // legal top-down bitmap, and no format can legitimately be 0-sized.
  const width = Math.abs(image.width);
  const height = Math.abs(image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PreviewFailure("corrupt");
  }
  return { width, height };
}

/** Strips script, foreignObject and event handlers, and drops javascript: URLs. */
export function sanitizeSvg(source: string): string {
  return DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject"],
  });
}

/**
 * Raster and vector images: the only work here is reading the declared size and
 * handing the browser a blob URL. No bitmap is built — the browser's image
 * pipeline keeps those outside the JS heap, so the ledger has nothing to charge.
 */
export function decodeImage(input: PreviewInput, ctx: DecodeContext): PreviewDocument {
  const sniffed = sniffImage(input.bytes);
  if (!sniffed) throw new PreviewFailure("corrupt");

  if (sniffed.format === "svg") {
    const source = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
    const sanitized = sanitizeSvg(source);
    const declared = readSvgSize(sanitized) ?? DEFAULT_SVG_SIZE;
    const { width, height } = requireSize({ format: "svg", ...declared });
    if (width * height > MAX_PAGE_PIXELS) throw new PreviewFailure("pixels_too_large");
    const blob = new Blob([sanitized], { type: "image/svg+xml" });
    const url = ownObjectUrl(ctx.scope, blob);
    return {
      kind: input.kind,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      surface: { surface: "vector", url, width, height },
    };
  }

  const { width, height } = requireSize(sniffed);
  if (width * height > MAX_PAGE_PIXELS) throw new PreviewFailure("pixels_too_large");
  const blob = new Blob([input.bytes], { type: input.contentType || `image/${sniffed.format}` });
  const url = ownObjectUrl(ctx.scope, blob);
  return {
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    surface: { surface: "raster", url, width, height, alt: sanitizeDisplayName(input.filename) },
  };
}
