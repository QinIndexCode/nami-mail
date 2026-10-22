/**
 * Deterministic attachment fixtures for the preview tests.
 *
 * Constraints, all of them load-bearing:
 * - Pure ESM with no imports: not the production preview modules (fixtures must
 *   not inherit their bugs) and not `node:` builtins (the same fixtures are
 *   usable from browser-environment suites and keep the tests honest about the
 *   bytes they feed the decoders).
 * - Only Web-platform primitives: `TextEncoder` and `CompressionStream` (plus
 *   the `Blob`/`Response` glue needed to drive a `CompressionStream`) produce
 *   every byte. Compression is therefore real deflate data, not a hand-written
 *   stream that only the ZIP decoder would accept.
 * - Deterministic: same inputs produce byte-identical output (fixed DOS
 *   timestamp, sorted/stable ordering), so tests can compare bytes and a failed
 *   fixture cannot pass by luck.
 */

const ONE_KIB = 1024;
const ONE_MIB = 1024 * ONE_KIB;

/** UTF-8 encode, the only text encoder the fixtures use. */
export function encodeFixtureText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

class ByteWriter {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  bytesOf(data: Uint8Array): this {
    for (const byte of data) this.bytes.push(byte);
    return this;
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const crcTable: number[] = [];
for (let entry = 0; entry < 256; entry += 1) {
  let value = entry;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable.push(value >>> 0);
}

/** Standard CRC-32 (ISO-HDLC), as stored in ZIP headers. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // `.slice()` narrows the view to an ArrayBuffer-backed buffer, which is what
  // the DOM `BlobPart` type (and the CompressionStream) wants under TS' typed
  // array generics.
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Fixed timestamp (2024-01-01 00:00) keeps ZIP bytes deterministic.
const dosDate = ((44 << 9) | (1 << 5) | 1) >>> 0;
const dosTime = 0;

export type ZipCompression = 0 | 8;

export type ZipEntryInput = {
  name: string;
  data: Uint8Array;
  /** 0 = stored, 8 = deflate. Defaults to 0 so tests can byte-compare "stored". */
  compression?: ZipCompression;
  /** General-purpose flag bits; bit 0 (0x0001) marks a traditional-encryption entry. */
  flags?: number;
  /**
   * Override the uncompressed size written to both headers. Used by the bomb
   * fixture, where the stream inflates to far more than the directory declares.
   */
  declaredUncompressedBytes?: number;
};

export type ZipFixture = {
  bytes: Uint8Array;
  entries: number;
  names: string[];
};

function zipLocalHeader(entry: ZipEntryInput, payload: Uint8Array): Uint8Array {
  const nameBytes = encodeFixtureText(entry.name);
  const declaredUncompressedBytes = entry.declaredUncompressedBytes ?? entry.data.byteLength;
  return new ByteWriter()
    .u32(0x04034b50)
    .u16(20)
    .u16(entry.flags ?? 0)
    .u16(entry.compression ?? 0)
    .u16(dosTime)
    .u16(dosDate)
    .u32(crc32(entry.data))
    .u32(payload.byteLength)
    .u32(declaredUncompressedBytes)
    .u16(nameBytes.byteLength)
    .u16(0)
    .bytesOf(nameBytes)
    .bytesOf(payload)
    .toUint8Array();
}

function zipCentralHeader(entry: ZipEntryInput, payload: Uint8Array, localOffset: number): Uint8Array {
  const nameBytes = encodeFixtureText(entry.name);
  const declaredUncompressedBytes = entry.declaredUncompressedBytes ?? entry.data.byteLength;
  return new ByteWriter()
    .u32(0x02014b50)
    .u16(20) // version made by
    .u16(20) // version needed
    .u16(entry.flags ?? 0)
    .u16(entry.compression ?? 0)
    .u16(dosTime)
    .u16(dosDate)
    .u32(crc32(entry.data))
    .u32(payload.byteLength)
    .u32(declaredUncompressedBytes)
    .u16(nameBytes.byteLength)
    .u16(0) // extra length
    .u16(0) // comment length
    .u16(0) // disk number start
    .u16(0) // internal attributes
    .u32(0) // external attributes
    .u32(localOffset)
    .bytesOf(nameBytes)
    .toUint8Array();
}

function zipEndOfCentralDirectory(entryCount: number, centralDirectoryBytes: number, centralDirectoryOffset: number): Uint8Array {
  return new ByteWriter()
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(entryCount)
    .u16(entryCount)
    .u32(centralDirectoryBytes)
    .u32(centralDirectoryOffset)
    .u16(0)
    .toUint8Array();
}

/** Builds a ZIP archive from explicit entries (real deflate streams for method 8). */
export async function makeZip(entries: readonly ZipEntryInput[]): Promise<ZipFixture> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const payload = (entry.compression ?? 0) === 8 ? await deflateRaw(entry.data) : entry.data;
    const local = zipLocalHeader(entry, payload);
    localParts.push(local);
    centralParts.push(zipCentralHeader(entry, payload, offset));
    offset += local.byteLength;
  }
  const centralDirectory = concatBytes(centralParts);
  const endOfCentralDirectory = zipEndOfCentralDirectory(entries.length, centralDirectory.byteLength, offset);
  return {
    bytes: concatBytes([...localParts, centralDirectory, endOfCentralDirectory]),
    entries: entries.length,
    names: entries.map((entry) => entry.name),
  };
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/** Declares 1 MiB in the central directory while the deflate stream inflates to 8 MiB. */
export type ZipBombFixture = ZipFixture & {
  declaredBytes: number;
  actualBytes: number;
  entryName: string;
};

export async function makeZipBomb(
  options: { declaredBytes?: number; actualBytes?: number } = {},
): Promise<ZipBombFixture> {
  const declaredBytes = options.declaredBytes ?? ONE_MIB;
  const actualBytes = options.actualBytes ?? 8 * ONE_MIB;
  const entryName = "bomb.bin";
  const zip = await makeZip([{
    name: entryName,
    data: new Uint8Array(actualBytes),
    compression: 8,
    declaredUncompressedBytes: declaredBytes,
  }]);
  return { ...zip, declaredBytes, actualBytes, entryName };
}

export type ZipLargeEntryFixture = ZipFixture & {
  entryName: string;
  uncompressedBytes: number;
};

/** An honest at-the-limit entry: declared size equals the real inflated size. */
export async function makeZipLargeEntry(
  options: { bytes?: number; compression?: ZipCompression } = {},
): Promise<ZipLargeEntryFixture> {
  const uncompressedBytes = options.bytes ?? 33 * ONE_MIB;
  const entryName = "large.bin";
  const zip = await makeZip([{
    name: entryName,
    data: new Uint8Array(uncompressedBytes),
    compression: options.compression ?? 8,
  }]);
  return { ...zip, entryName, uncompressedBytes };
}

export async function makeZipManyEntries(options: { count?: number } = {}): Promise<ZipFixture> {
  const count = options.count ?? 201;
  const entries: ZipEntryInput[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      name: `file-${String(index + 1).padStart(3, "0")}.txt`,
      data: encodeFixtureText(`entry ${index + 1}\n`),
    });
  }
  return makeZip(entries);
}

/** One entry carrying the traditional-encryption flag, so readers must refuse it without decrypting. */
export async function makeZipEncrypted(): Promise<ZipFixture> {
  return makeZip([{ name: "secret.txt", data: encodeFixtureText("encrypted payload"), flags: 0x0001 }]);
}

/** Archive entries that try to escape the extraction root. */
export async function makeZipWithTraversal(): Promise<ZipFixture> {
  return makeZip([
    { name: "../escape.txt", data: encodeFixtureText("escape") },
    { name: "folder/../../escape.txt", data: encodeFixtureText("escape") },
    { name: "safe/file.txt", data: encodeFixtureText("safe") },
  ]);
}

const docxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const docxPackageRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** The parts a Word decoder must find; also the fixture self-check's contract. */
export const docxRequiredParts = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] as const;

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function docxDocumentXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body></w:document>`;
}

export type DocxOptions = {
  text?: string;
  /** Full replacement for `word/document.xml` (used by the billion-laughs fixture). */
  documentXml?: string;
  extraEntries?: readonly ZipEntryInput[];
};

export async function makeDocx(options: DocxOptions = {}): Promise<ZipFixture> {
  const documentXml = options.documentXml ?? docxDocumentXml(options.text ?? "Hello from the fixture docx");
  return makeZip([
    { name: "[Content_Types].xml", data: encodeFixtureText(docxContentTypes), compression: 8 },
    { name: "_rels/.rels", data: encodeFixtureText(docxPackageRelationships), compression: 8 },
    { name: "word/document.xml", data: encodeFixtureText(documentXml), compression: 8 },
    ...(options.extraEntries ?? []),
  ]);
}

export type DocxBillionLaughsFixture = ZipFixture & { entityLevels: number };

/**
 * A real .docx container whose `word/document.xml` recursively expands ten
 * entity levels. Decoders must reject the DOCTYPE before touching an XML parser;
 * expanding it is the billion-laughs amplification.
 */
export async function makeDocxBillionLaughs(options: { levels?: number } = {}): Promise<DocxBillionLaughsFixture> {
  const entityLevels = options.levels ?? 10;
  const declarations = ['<!ENTITY lol0 "lol">'];
  for (let level = 1; level < entityLevels; level += 1) {
    declarations.push(`<!ENTITY lol${level} "${`&lol${level - 1};`.repeat(10)}">`);
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE w:document [
${declarations.join("\n")}
]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol${entityLevels - 1};</w:t></w:r></w:p></w:body></w:document>`;
  const zip = await makeDocx({ documentXml });
  return { ...zip, entityLevels };
}

const xlsxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

const xlsxPackageRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const xlsxWorkbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const xlsxWorkbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

const xlsxSharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Name</t></si><si><t>Alice</t></si></sst>`;

const xlsxSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>`;

/** The parts an XLSX decoder reads: workbook, shared strings and the first sheet. */
export const xlsxRequiredParts = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/worksheets/sheet1.xml",
  "xl/sharedStrings.xml",
] as const;

export async function makeXlsx(): Promise<ZipFixture> {
  return makeZip([
    { name: "[Content_Types].xml", data: encodeFixtureText(xlsxContentTypes), compression: 8 },
    { name: "_rels/.rels", data: encodeFixtureText(xlsxPackageRelationships), compression: 8 },
    { name: "xl/workbook.xml", data: encodeFixtureText(xlsxWorkbook), compression: 8 },
    { name: "xl/_rels/workbook.xml.rels", data: encodeFixtureText(xlsxWorkbookRelationships), compression: 8 },
    { name: "xl/sharedStrings.xml", data: encodeFixtureText(xlsxSharedStrings), compression: 8 },
    { name: "xl/worksheets/sheet1.xml", data: encodeFixtureText(xlsxSheet), compression: 8 },
  ]);
}

const pptxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`;

const pptxPackageRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;

const pptxPresentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`;

const pptxSlide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>Slide title</a:t></a:r></a:p><a:p><a:r><a:t>Slide body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/** The parts a slides decoder reads. */
export const pptxRequiredParts = [
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/presentation.xml",
  "ppt/slides/slide1.xml",
] as const;

export async function makePptx(): Promise<ZipFixture> {
  return makeZip([
    { name: "[Content_Types].xml", data: encodeFixtureText(pptxContentTypes), compression: 8 },
    { name: "_rels/.rels", data: encodeFixtureText(pptxPackageRelationships), compression: 8 },
    { name: "ppt/presentation.xml", data: encodeFixtureText(pptxPresentation), compression: 8 },
    { name: "ppt/slides/slide1.xml", data: encodeFixtureText(pptxSlide), compression: 8 },
  ]);
}

export type TextFixtureBom = "none" | "utf-8" | "utf-16le" | "utf-16be";

export type TextFixtureOptions = {
  text?: string;
  bom?: TextFixtureBom;
};

/** Text fixtures with the BOM variants a decoder has to strip. */
export function makeTextFixture(options: TextFixtureOptions = {}): Uint8Array {
  const text = options.text ?? "Nami Mail attachment fixture\n";
  const bom = options.bom ?? "none";
  if (bom === "utf-16le") return concatBytes([new Uint8Array([0xff, 0xfe]), encodeUtf16(text, true)]);
  if (bom === "utf-16be") return concatBytes([new Uint8Array([0xfe, 0xff]), encodeUtf16(text, false)]);
  if (bom === "utf-8") return concatBytes([new Uint8Array([0xef, 0xbb, 0xbf]), encodeFixtureText(text)]);
  return encodeFixtureText(text);
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    bytes[index * 2] = littleEndian ? codeUnit & 0xff : (codeUnit >>> 8) & 0xff;
    bytes[index * 2 + 1] = littleEndian ? (codeUnit >>> 8) & 0xff : codeUnit & 0xff;
  }
  return bytes;
}

function concatFixtureParts(parts: readonly Uint8Array[]): Uint8Array {
  return concatBytes(parts);
}

/** Deliberately hostile SVG: script element plus an event handler attribute. */
export function makeSvgWithScript(): Uint8Array {
  return encodeFixtureText(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" onload="alert('svg-onload')">`
      + `<script>alert('svg-script')</script><rect width="16" height="16" fill="red"/></svg>`,
  );
}

/** Minimal, structurally valid PDF; `pages` drives the page-tree size. */
export function makePdfFixture(options: { pages?: number } = {}): Uint8Array {
  const pages = options.pages ?? 1;
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const firstPageObject = 3;
  const objectsPerPage = 2;
  const fontObjectNumber = firstPageObject + pages * objectsPerPage;
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    pageObjectNumbers.push(firstPageObject + pageIndex * objectsPerPage);
  }
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages} >>`);
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const pageNumber = pageObjectNumbers[pageIndex] ?? firstPageObject;
    const contentNumber = pageNumber + 1;
    const content = `BT /F1 12 Tf 72 720 Td (Page ${pageIndex + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  // ASCII-only header: the xref offsets below are computed as string lengths,
  // so any multi-byte character would move every object offset.
  const header = "%PDF-1.7\n";
  let body = "";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(header.length + body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = header.length + body.length;
  const xrefLines = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ];
  return encodeFixtureText(header + body + xrefLines.join("\n"));
}

function u16beBytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u32beBytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function makePngFixture(options: { width?: number; height?: number } = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 32;
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // PNG stores chunk fields big-endian (unlike ZIP): width/height must be BE.
  const ihdrData = new Uint8Array([...u32beBytes(width), ...u32beBytes(height), 8, 6, 0, 0, 0]);
  const ihdr = pngChunk("IHDR", ihdrData);
  const iend = pngChunk("IEND", new Uint8Array(0));
  return concatFixtureParts([signature, ihdr, iend]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encodeFixtureText(type);
  const body = concatFixtureParts([typeBytes, data]);
  const checksum = crc32(body);
  return new ByteWriter()
    .u32(data.byteLength)
    .bytesOf(typeBytes)
    .bytesOf(data)
    .u32(checksum)
    .toUint8Array();
}

export function makeJpegFixture(options: { width?: number; height?: number } = {}): Uint8Array {
  const width = options.width ?? 320;
  const height = options.height ?? 200;
  // JPEG markers store their segment lengths and dimensions big-endian.
  const app0 = new ByteWriter()
    .u8(0xff).u8(0xe0).u8(0x00).u8(16)
    .bytesOf(encodeFixtureText("JFIF\0"))
    .u8(1).u8(1).u8(0)
    .u8(0).u8(1).u8(0).u8(1).u8(0).u8(0)
    .toUint8Array();
  const sof0 = new ByteWriter()
    .u8(0xff).u8(0xc0).u8(0x00).u8(17)
    .u8(8)
    .bytesOf(u16beBytes(height))
    .bytesOf(u16beBytes(width))
    .u8(3)
    .u8(1).u8(0x11).u8(0).u8(2).u8(0x11).u8(1).u8(3).u8(0x11).u8(1)
    .toUint8Array();
  return concatFixtureParts([new Uint8Array([0xff, 0xd8]), app0, sof0, new Uint8Array([0xff, 0xd9])]);
}

export function makeGifFixture(options: { width?: number; height?: number } = {}): Uint8Array {
  const width = options.width ?? 120;
  const height = options.height ?? 90;
  return concatFixtureParts([
    encodeFixtureText("GIF89a"),
    new ByteWriter().u16(width).u16(height).u8(0x00).u8(0).u8(0).toUint8Array(),
    new Uint8Array([0x3b]),
  ]);
}

export function makeWebpFixture(options: { width?: number; height?: number } = {}): Uint8Array {
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const canvasWidthMinusOne = width - 1;
  const canvasHeightMinusOne = height - 1;
  const vp8xData = new Uint8Array([
    0, 0, 0, 0,
    canvasWidthMinusOne & 0xff, (canvasWidthMinusOne >>> 8) & 0xff, (canvasWidthMinusOne >>> 16) & 0xff,
    canvasHeightMinusOne & 0xff, (canvasHeightMinusOne >>> 8) & 0xff, (canvasHeightMinusOne >>> 16) & 0xff,
  ]);
  const chunk = new ByteWriter()
    .bytesOf(encodeFixtureText("VP8X"))
    .u32(vp8xData.byteLength)
    .bytesOf(vp8xData)
    .toUint8Array();
  const riffPayload = concatFixtureParts([encodeFixtureText("WEBP"), chunk]);
  return new ByteWriter()
    .bytesOf(encodeFixtureText("RIFF"))
    .u32(riffPayload.byteLength)
    .bytesOf(riffPayload)
    .toUint8Array();
}

export function makeBmpFixture(options: { width?: number; height?: number } = {}): Uint8Array {
  const width = options.width ?? 100;
  const height = options.height ?? 50;
  const dibHeader = new ByteWriter()
    .u32(40).u32(width).u32(height).u16(1).u16(24).u32(0).u32(0)
    .u32(2835).u32(2835).u32(0).u32(0)
    .toUint8Array();
  const fileHeader = new ByteWriter()
    .bytesOf(encodeFixtureText("BM"))
    .u32(14 + dibHeader.byteLength)
    .u16(0).u16(0)
    .u32(14 + dibHeader.byteLength)
    .toUint8Array();
  return concatFixtureParts([fileHeader, dibHeader]);
}

/** Sizes used by the preview budget tests, exported so tests name the same numbers as the plan. */
export const fixtureSizes = Object.freeze({
  oneKib: ONE_KIB,
  oneMib: ONE_MIB,
  zipBombDeclaredBytes: ONE_MIB,
  zipBombActualBytes: 8 * ONE_MIB,
  honestLimitBytes: 33 * ONE_MIB,
});
