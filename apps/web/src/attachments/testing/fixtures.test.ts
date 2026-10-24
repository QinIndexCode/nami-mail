// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  docxRequiredParts,
  encodeFixtureText,
  fixtureSizes,
  makeBmpFixture,
  makeDocx,
  makeDocxBillionLaughs,
  makeGifFixture,
  makeJpegFixture,
  makePdfFixture,
  makePngFixture,
  makePptx,
  makeSvgWithScript,
  makeTextFixture,
  makeWebpFixture,
  makeXlsx,
  makeZip,
  makeZipBomb,
  makeZipEncrypted,
  makeZipLargeEntry,
  makeZipManyEntries,
  makeZipWithTraversal,
  pptxRequiredParts,
  xlsxRequiredParts,
} from "./fixtures";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function readU32BigEndian(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>): boolean {
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return textDecoder.decode(bytes.subarray(offset, offset + length));
}

type ParsedZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localUncompressedBytes: number;
  localFlags: number;
  dataOffset: number;
};

/** Independently parses the central directory; deliberately not using the production reader. */
function parseZipCentralDirectory(bytes: Uint8Array): ParsedZipEntry[] {
  let endOfCentralDirectory = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50 && readU16(bytes, offset + 20) === 0) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  expect(endOfCentralDirectory, "ZIP end-of-central-directory record").toBeGreaterThanOrEqual(0);
  const entryCount = readU16(bytes, endOfCentralDirectory + 10);
  const centralDirectoryOffset = readU32(bytes, endOfCentralDirectory + 16);
  const entries: ParsedZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    expect(readU32(bytes, cursor), `central header ${index}`).toBe(0x02014b50);
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const compressedBytes = readU32(bytes, cursor + 20);
    const uncompressedBytes = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    const name = asciiAt(bytes, cursor + 46, nameLength);
    expect(readU32(bytes, localOffset), `local header for ${name}`).toBe(0x04034b50);
    const localFlags = readU16(bytes, localOffset + 6);
    const localUncompressedBytes = readU32(bytes, localOffset + 22);
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    entries.push({
      name,
      method,
      flags,
      compressedBytes,
      uncompressedBytes,
      localUncompressedBytes,
      localFlags,
      dataOffset: localOffset + 30 + localNameLength + localExtraLength,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // `.slice()` narrows the view to an ArrayBuffer-backed buffer (DOM BlobPart).
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntryData(bytes: Uint8Array, entry: ParsedZipEntry): Promise<Uint8Array> {
  const payload = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes);
  return entry.method === 8 ? inflateRaw(payload) : payload;
}

async function readZipEntryText(bytes: Uint8Array, name: string): Promise<string> {
  const entry = parseZipCentralDirectory(bytes).find((candidate) => candidate.name === name);
  expect(entry, `${name} must exist in the archive`).toBeDefined();
  return textDecoder.decode(await readZipEntryData(bytes, entry!));
}

function sniff(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, encodeFixtureText("GIF89a"))) return "gif";
  if (startsWith(bytes, encodeFixtureText("RIFF"))) return "webp";
  if (startsWith(bytes, encodeFixtureText("BM"))) return "bmp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(bytes, encodeFixtureText("<svg"))) return "svg";
  return "unknown";
}

describe("attachment fixtures", () => {
  it("starts every fixture with the magic its decoder looks for", async () => {
    expect(sniff(makePdfFixture())).toBe("pdf");
    expect(sniff(makePngFixture())).toBe("png");
    expect(sniff(makeJpegFixture())).toBe("jpeg");
    expect(sniff(makeGifFixture())).toBe("gif");
    expect(sniff(makeWebpFixture())).toBe("webp");
    expect(sniff(makeBmpFixture())).toBe("bmp");
    expect(sniff(makeSvgWithScript())).toBe("svg");
    expect(sniff(makeTextFixture().subarray(0, 4))).toBe("unknown");
    for (const zip of [await makeDocx(), await makeXlsx(), await makePptx(), await makeZipManyEntries({ count: 1 })]) {
      expect(sniff(zip.bytes)).toBe("zip");
    }
  });

  it("builds a ZIP whose central directory describes stored and deflated entries truthfully", async () => {
    const stored = encodeFixtureText("stored payload");
    const deflated = textEncoder.encode("deflated payload ".repeat(100));
    const zip = await makeZip([
      { name: "stored.txt", data: stored, compression: 0 },
      { name: "deflated.txt", data: deflated, compression: 8 },
    ]);
    expect(zip.entries).toBe(2);
    const entries = parseZipCentralDirectory(zip.bytes);
    expect(entries.map((entry) => entry.name)).toEqual(["stored.txt", "deflated.txt"]);
    expect(entries[0]!.method).toBe(0);
    expect(entries[1]!.method).toBe(8);
    for (const entry of entries) {
      expect(entry.localUncompressedBytes, `${entry.name} local header size`).toBe(entry.uncompressedBytes);
      expect(entry.localFlags, `${entry.name} local header flags`).toBe(entry.flags);
    }
    expect(entries[0]!.uncompressedBytes).toBe(stored.byteLength);
    expect(Array.from(await readZipEntryData(zip.bytes, entries[0]!))).toEqual(Array.from(stored));
    expect(entries[1]!.compressedBytes).toBeLessThan(deflated.byteLength);
    expect(Array.from(await readZipEntryData(zip.bytes, entries[1]!))).toEqual(Array.from(deflated));
  });

  it("builds a real DOCX container with the parts a Word decoder reads", async () => {
    const docx = await makeDocx({ text: "Hello from the fixture docx" });
    const entries = parseZipCentralDirectory(docx.bytes);
    for (const part of docxRequiredParts) {
      expect(entries.map((entry) => entry.name), `${part} must be present`).toContain(part);
    }
    expect(await readZipEntryText(docx.bytes, "[Content_Types].xml")).toContain("wordprocessingml.document.main+xml");
    const documentXml = await readZipEntryText(docx.bytes, "word/document.xml");
    expect(documentXml).toContain("Hello from the fixture docx");
    expect(documentXml).not.toContain("<!DOCTYPE");
  });

  it("carries ten recursive entity levels inside a real DOCX container", async () => {
    const fixture = await makeDocxBillionLaughs();
    expect(fixture.entityLevels).toBe(10);
    const entries = parseZipCentralDirectory(fixture.bytes);
    for (const part of docxRequiredParts) {
      expect(entries.map((entry) => entry.name)).toContain(part);
    }
    const documentXml = await readZipEntryText(fixture.bytes, "word/document.xml");
    expect(documentXml).toContain("<!DOCTYPE");
    expect([...documentXml.matchAll(/<!ENTITY /g)]).toHaveLength(10);
    expect(documentXml).toContain('<!ENTITY lol9 "&lol8;&lol8;');
    expect(documentXml).toContain("&lol9;");
  });

  it("declares 1 MiB for the zip bomb while the stream really inflates to 8 MiB", async () => {
    const bomb = await makeZipBomb();
    expect(bomb.declaredBytes).toBe(fixtureSizes.zipBombDeclaredBytes);
    expect(bomb.actualBytes).toBe(fixtureSizes.zipBombActualBytes);
    const entries = parseZipCentralDirectory(bomb.bytes);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.name).toBe(bomb.entryName);
    expect(entry!.uncompressedBytes).toBe(fixtureSizes.zipBombDeclaredBytes);
    expect(entry!.localUncompressedBytes).toBe(fixtureSizes.zipBombDeclaredBytes);
    const inflated = await readZipEntryData(bomb.bytes, entry!);
    expect(inflated.byteLength).toBe(fixtureSizes.zipBombActualBytes);
  });

  it("offers an honest 33 MiB entry and a 201-entry archive", async () => {
    const large = await makeZipLargeEntry();
    expect(large.uncompressedBytes).toBe(fixtureSizes.honestLimitBytes);
    const [largeEntry] = parseZipCentralDirectory(large.bytes);
    expect(largeEntry!.uncompressedBytes).toBe(fixtureSizes.honestLimitBytes);
    expect((await readZipEntryData(large.bytes, largeEntry!)).byteLength).toBe(fixtureSizes.honestLimitBytes);

    const many = await makeZipManyEntries();
    expect(many.entries).toBe(201);
    const entries = parseZipCentralDirectory(many.bytes);
    expect(entries).toHaveLength(201);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(201);
  });

  it("marks the encrypted entry and keeps traversal names verbatim", async () => {
    const encrypted = await makeZipEncrypted();
    const [encryptedEntry] = parseZipCentralDirectory(encrypted.bytes);
    expect(encryptedEntry!.flags & 0x0001, "encryption flag bit").toBe(1);
    expect(encryptedEntry!.localFlags & 0x0001, "local encryption flag bit").toBe(1);

    const traversal = await makeZipWithTraversal();
    expect(parseZipCentralDirectory(traversal.bytes).map((entry) => entry.name)).toEqual([
      "../escape.txt",
      "folder/../../escape.txt",
      "safe/file.txt",
    ]);
  });

  it("builds spreadsheets and slide decks with the parts their decoders read", async () => {
    const xlsx = await makeXlsx();
    const xlsxNames = parseZipCentralDirectory(xlsx.bytes).map((entry) => entry.name);
    for (const part of xlsxRequiredParts) expect(xlsxNames).toContain(part);
    expect(await readZipEntryText(xlsx.bytes, "xl/sharedStrings.xml")).toContain("Alice");
    expect(await readZipEntryText(xlsx.bytes, "xl/worksheets/sheet1.xml")).toContain('<c r="B1">');

    const pptx = await makePptx();
    const pptxNames = parseZipCentralDirectory(pptx.bytes).map((entry) => entry.name);
    for (const part of pptxRequiredParts) expect(pptxNames).toContain(part);
    expect(await readZipEntryText(pptx.bytes, "ppt/slides/slide1.xml")).toContain("Slide title");
  });

  it("embeds the requested dimensions in all five raster headers", () => {
    const width = 800;
    const height = 600;

    const png = makePngFixture({ width, height });
    expect(readU32BigEndian(png, 16)).toBe(width);
    expect(readU32BigEndian(png, 20)).toBe(height);

    const jpeg = makeJpegFixture({ width, height });
    const sof0 = jpeg.findIndex((_byte, index) => (jpeg[index] === 0xff && jpeg[index + 1] === 0xc0));
    expect(sof0).toBeGreaterThanOrEqual(0);
    expect(readU16BigEndian(jpeg, sof0 + 5)).toBe(height);
    expect(readU16BigEndian(jpeg, sof0 + 7)).toBe(width);

    const gif = makeGifFixture({ width, height });
    expect(readU16(gif, 6)).toBe(width);
    expect(readU16(gif, 8)).toBe(height);

    const webp = makeWebpFixture({ width, height });
    expect(asciiAt(webp, 12, 4)).toBe("VP8X");
    const webpWidth = (webp[24] ?? 0) | ((webp[25] ?? 0) << 8) | ((webp[26] ?? 0) << 16);
    const webpHeight = (webp[27] ?? 0) | ((webp[28] ?? 0) << 8) | ((webp[29] ?? 0) << 16);
    expect(webpWidth + 1).toBe(width);
    expect(webpHeight + 1).toBe(height);

    const bmp = makeBmpFixture({ width, height });
    expect(readU32(bmp, 18)).toBe(width);
    expect(readU32(bmp, 22)).toBe(height);
  });

  it("tags text fixtures with the BOM the decoder must strip", () => {
    expect(Array.from(makeTextFixture({ bom: "utf-8", text: "x" }).subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(makeTextFixture({ bom: "utf-16le", text: "x" }).subarray(0, 2))).toEqual([0xff, 0xfe]);
    expect(Array.from(makeTextFixture({ bom: "utf-16be", text: "x" }).subarray(0, 2))).toEqual([0xfe, 0xff]);
    expect(Array.from(makeTextFixture({ text: "plain" }))).toEqual(Array.from(encodeFixtureText("plain")));
    const utf16 = makeTextFixture({ bom: "utf-16le", text: "hi" });
    expect(Array.from(utf16.subarray(2))).toEqual([0x68, 0x00, 0x69, 0x00]);
  });

  it("keeps the malicious SVG hostile so the sanitizing tests have something to catch", () => {
    const svg = textDecoder.decode(makeSvgWithScript());
    expect(svg).toContain("<script>alert('svg-script')</script>");
    expect(svg).toContain("onload=");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("writes a structurally consistent PDF whose page count is real", () => {
    for (const pages of [1, 2, 200]) {
      const pdf = textDecoder.decode(makePdfFixture({ pages }));
      expect(pdf.startsWith("%PDF-1.7\n")).toBe(true);
      expect(pdf).toContain(`/Count ${pages}`);
      expect(pdf).toContain(`(Page ${pages})`);
      const startxref = /startxref\n(\d+)\n%%EOF\n$/.exec(pdf);
      expect(startxref, "startxref trailer").not.toBeNull();
      expect(pdf.slice(Number(startxref![1]), Number(startxref![1]) + 4)).toBe("xref");
    }
  });
});
