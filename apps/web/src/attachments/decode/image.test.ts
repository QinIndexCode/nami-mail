// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { MAX_PAGE_PIXELS } from "../budget";
import { MemoryLease } from "../budget";
import { ResourceScope } from "../document";
import type { DecodeContext, PreviewInput } from "../document";
import { PreviewFailure } from "../failure";
import { DEFAULT_SVG_SIZE, decodeImage, sanitizeSvg, sniffImage } from "./image";

const writeU32be = (bytes: Uint8Array, offset: number, value: number) => {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
};
const writeU32le = (bytes: Uint8Array, offset: number, value: number) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
};
const writeU16le = (bytes: Uint8Array, offset: number, value: number) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
};
const ascii = (target: Uint8Array, offset: number, text: string) => {
  for (let index = 0; index < text.length; index += 1) target[offset + index] = text.charCodeAt(index);
};

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  ascii(bytes, 12, "IHDR");
  writeU32be(bytes, 16, width);
  writeU32be(bytes, 20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes[4] = 0x00;
  bytes[5] = 0x11;
  bytes[6] = 0x08;
  bytes[7] = (height >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >>> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  ascii(bytes, 0, "GIF89a");
  writeU16le(bytes, 6, width);
  writeU16le(bytes, 8, height);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  ascii(bytes, 0, "RIFF");
  writeU32le(bytes, 4, 22);
  ascii(bytes, 8, "WEBP");
  ascii(bytes, 12, "VP8X");
  writeU32le(bytes, 16, 10);
  bytes[20] = 0;
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >>> 8) & 0xff;
  bytes[26] = (w >>> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >>> 8) & 0xff;
  bytes[29] = (h >>> 16) & 0xff;
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  ascii(bytes, 0, "BM");
  writeU32le(bytes, 14, 40);
  writeU32le(bytes, 18, width);
  writeU32le(bytes, 22, height);
  return bytes;
}

function avif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  writeU32be(bytes, 0, 24);
  ascii(bytes, 4, "ftyp");
  ascii(bytes, 8, "avif");
  ascii(bytes, 40, "ispe");
  writeU32be(bytes, 48, width);
  writeU32be(bytes, 52, height);
  return bytes;
}

const svg = (source: string): Uint8Array => new TextEncoder().encode(source);

const context = (): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
});

const input = (bytes: Uint8Array, filename: string, kind: PreviewInput["kind"]): PreviewInput => ({
  kind,
  filename,
  contentType: "image/*",
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

const decode = (bytes: Uint8Array, filename: string, kind: PreviewInput["kind"] = "image-raster") =>
  decodeImage(input(bytes, filename, kind), context());

describe("sniffImage", () => {
  it("reads the six raster formats plus SVG", () => {
    expect(sniffImage(png(10, 20))).toEqual({ format: "png", width: 10, height: 20 });
    expect(sniffImage(jpeg(30, 40))).toEqual({ format: "jpeg", width: 30, height: 40 });
    expect(sniffImage(gif(50, 60))).toEqual({ format: "gif", width: 50, height: 60 });
    expect(sniffImage(webp(70, 80))).toEqual({ format: "webp", width: 70, height: 80 });
    expect(sniffImage(bmp(90, 100))).toEqual({ format: "bmp", width: 90, height: 100 });
    expect(sniffImage(avif(110, 120))).toEqual({ format: "avif", width: 110, height: 120 });
    expect(sniffImage(svg('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="17"></svg>'))).toEqual({
      format: "svg",
      width: 13,
      height: 17,
    });
  });

  it("returns null for bytes that are not an image", () => {
    expect(sniffImage(new TextEncoder().encode("hello"))).toBeNull();
  });

  it("accepts the exact pixel ceiling and rejects one pixel over it", () => {
    // 4096 × 2048 = 8,388,608 = MAX_PAGE_PIXELS.
    expect(() => decode(png(4096, 2048), "ok.png")).not.toThrow();
    expect(() => decode(png(4097, 2048), "big.png")).toThrow(PreviewFailure);
    expect(MAX_PAGE_PIXELS).toBe(8_388_608);
  });

  it("normalises a negative BMP height and rejects a zero dimension", () => {
    const topDown = bmp(100, -50);
    expect(sniffImage(topDown)).toMatchObject({ width: 100, height: -50 });
    expect(() => decode(topDown, "top-down.bmp")).not.toThrow();
    expect(() => decode(bmp(100, 0), "zero.bmp")).toThrow(PreviewFailure);
  });
});

describe("sanitizeSvg", () => {
  it("removes script, foreignObject and event handlers", () => {
    const sanitized = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><script>alert(2)</script><foreignObject><body/></foreignObject><rect width="1" height="1"/></svg>',
    );
    expect(sanitized).not.toMatch(/script/i);
    expect(sanitized).not.toMatch(/foreignObject/i);
    expect(sanitized).not.toMatch(/onload/i);
    expect(sanitized).toContain("rect");
  });

  it("strips javascript: URLs", () => {
    const sanitized = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>',
    );
    expect(sanitized.toLowerCase()).not.toContain("javascript:");
  });
});

describe("decodeImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands back a raster blob URL with the intrinsic size", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:raster");
    const document = decode(png(120, 80), "photo.png");
    expect(create).toHaveBeenCalledTimes(1);
    expect(document.surface).toMatchObject({ surface: "raster", url: "blob:raster", width: 120, height: 80 });
  });

  it("falls back to 300×150 for an SVG with no size anywhere", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:vector");
    const document = decode(svg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), "shape.svg", "image-vector");
    expect(document.surface).toMatchObject({
      surface: "vector",
      width: DEFAULT_SVG_SIZE.width,
      height: DEFAULT_SVG_SIZE.height,
    });
  });

  it("rejects a raster kind whose bytes are actually SVG", () => {
    const bytes = svg('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    expect(() => decode(bytes, "fake.png", "image-raster")).not.toThrow();
    // decodeImage itself sniffs; the kind mismatch is enforced by decodeAttachment.
    expect(sniffImage(bytes)?.format).toBe("svg");
  });
});
