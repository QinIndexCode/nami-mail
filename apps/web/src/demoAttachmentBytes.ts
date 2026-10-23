/**
 * Deterministic demo attachment bytes (plan §4.5 S4).
 *
 * Demo mode used to refuse the preview outright, so the fixtures below never
 * existed. They are built here rather than checked in as binaries for three
 * reasons: the repository stays binary-free, the fixtures are obviously safe
 * (every byte is in this file), and `demoAttachmentBytes.test.ts` can assert
 * their structure instead of trusting a blob.
 *
 * Only Web-platform primitives are used — no imports, no `node:` builtins, no
 * randomness — so the same module runs in the browser, in jsdom and in node.
 */

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF: two pages, Helvetica text and a filled rectangle, hand-written xref.
// ---------------------------------------------------------------------------

const PAGE_DICTIONARY =
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents %CONTENT% 0 R >>";

/** One page's content stream: a heading-ish text run plus a solid block. */
function pdfContent(text: string, color: string): Uint8Array<ArrayBuffer> {
  return ascii(`BT /F1 24 Tf 72 720 Td (${text}) Tj ET\n${color} rg\n72 596 220 84 re f`);
}

/**
 * `%PDF-1.7` with objects 1–7 and a computed cross-reference table. The text is
 * ASCII-only and every `/Length` is the real byte count of its stream, which is
 * what pdf.js actually checks.
 */
export function buildDemoPdf(): Uint8Array<ArrayBuffer> {
  const pageOne = pdfContent("Demo invoice - page one", "0.16 0.32 0.72");
  const pageTwo = pdfContent("Demo invoice - page two", "0.72 0.24 0.16");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array<ArrayBuffer>) => {
    chunks.push(bytes);
    offset += bytes.byteLength;
  };
  const addObject = (bytes: Uint8Array<ArrayBuffer>) => {
    offsets.push(offset);
    push(bytes);
  };
  const dictionary = (number: number, body: string) => ascii(`${number} 0 obj\n${body}\nendobj\n`);
  const stream = (number: number, content: Uint8Array<ArrayBuffer>) =>
    concat([ascii(`${number} 0 obj\n<< /Length ${content.byteLength} >>\nstream\n`), content, ascii("\nendstream\nendobj\n")]);

  push(ascii("%PDF-1.7\n"));
  addObject(dictionary(1, "<< /Type /Catalog /Pages 2 0 R >>"));
  addObject(dictionary(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"));
  addObject(dictionary(3, PAGE_DICTIONARY.replace("%CONTENT%", "6")));
  addObject(dictionary(4, PAGE_DICTIONARY.replace("%CONTENT%", "7")));
  addObject(dictionary(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  addObject(stream(6, pageOne));
  addObject(stream(7, pageTwo));

  const xrefOffset = offset;
  // Every entry is exactly 20 bytes, which is what makes the table valid.
  let xref = "xref\n0 8\n0000000000 65535 f \n";
  for (const objectOffset of offsets) xref += `${String(objectOffset).padStart(10, "0")} 00000 n \n`;
  push(ascii(xref));
  push(ascii(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concat(chunks);
}

// ---------------------------------------------------------------------------
// ZIP: stored entries only, fixed timestamp, so the bytes are deterministic.
// ---------------------------------------------------------------------------

const crcTable: number[] = [];
for (let entry = 0; entry < 256; entry += 1) {
  let value = entry;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable.push(value >>> 0);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

class Writer {
  private readonly bytes: number[] = [];

  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  raw(data: Uint8Array): this {
    for (const byte of data) this.bytes.push(byte);
    return this;
  }

  done(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.bytes);
  }
}

// 2024-01-01 00:00, encoded the way DOS did it, so ZIP bytes never drift.
const DOS_DATE = ((44 << 9) | (1 << 5) | 1) >>> 0;

/**
 * A stored-only archive. `entries` is what the archive decoder counts, so 201
 * produces the `too_many_entries` error state without any inflation work.
 */
export function buildDemoZip(options: { entries?: number } = {}): Uint8Array<ArrayBuffer> {
  const count = options.entries ?? 201;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const label = String(index + 1).padStart(3, "0");
    const name = ascii(`photo-${label}.jpg`);
    // Not a real JPEG: the archive surface never opens an entry.
    const data = ascii(`demo photo placeholder ${label}\n`);
    const crc = crc32(data);
    const local = new Writer()
      .u32(0x04034b50)
      .u16(20)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(DOS_DATE)
      .u32(crc)
      .u32(data.byteLength)
      .u32(data.byteLength)
      .u16(name.byteLength)
      .u16(0)
      .raw(name)
      .raw(data)
      .done();
    centrals.push(
      new Writer()
        .u32(0x02014b50)
        .u16(20)
        .u16(20)
        .u16(0)
        .u16(0)
        .u16(0)
        .u16(DOS_DATE)
        .u32(crc)
        .u32(data.byteLength)
        .u32(data.byteLength)
        .u16(name.byteLength)
        .u16(0)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(offset)
        .raw(name)
        .done(),
    );
    locals.push(local);
    offset += local.byteLength;
  }
  const centralDirectory = concat(centrals);
  const eocd = new Writer()
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(count)
    .u16(count)
    .u32(centralDirectory.byteLength)
    .u32(offset)
    .u16(0)
    .done();
  return concat([...locals, centralDirectory, eocd]);
}

// ---------------------------------------------------------------------------
// The remaining demo kinds.
// ---------------------------------------------------------------------------

/**
 * A valid-looking SVG carrying both payload classes the sanitizer must remove:
 * a `<script>` element and an `onload` attribute on the root.
 */
export function buildDemoSvgWithScript(): Uint8Array<ArrayBuffer> {
  return ascii(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200" onload="alert(\'onload\')">',
      '<rect x="0" y="0" width="320" height="200" fill="#eef2ff"/>',
      '<circle cx="96" cy="100" r="48" fill="#4f46e5"/>',
      '<text x="168" y="106" font-family="Helvetica" font-size="18" fill="#312e81">Demo SVG</text>',
      "<script>alert(1)</script>",
      "</svg>",
    ].join(""),
  );
}

/** The PSD file header (26 bytes). Tier C: the drawer never requests these bytes. */
export function buildDemoPsd(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x38, 0x42, 0x50, 0x53, // "8BPS"
    0x00, 0x01, // version 1
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x03, // channels
    0x00, 0x00, 0x03, 0x20, // height 800
    0x00, 0x00, 0x02, 0x58, // width 600
    0x00, 0x08, // 8 bits per channel
    0x00, 0x03, // RGB colour mode
  ]);
}

/** Plain text for the demo's text surface. */
export function buildDemoText(): Uint8Array<ArrayBuffer> {
  return ascii("Demo notes\n\nThis file exists so the text surface has a demo attachment.\n");
}

export type DemoAttachmentFixture = {
  filename: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
};

/** Keyed by `${messageId}/${partId}`, the same pair the ingress provider gets. */
export const demoAttachmentFixtures: Record<string, DemoAttachmentFixture> = {
  "m2/2": {
    filename: "july-review-notes.pdf",
    contentType: "application/pdf",
    bytes: buildDemoPdf(),
  },
  "m2/3": {
    filename: "moodboard.svg",
    contentType: "image/svg+xml",
    bytes: buildDemoSvgWithScript(),
  },
  "m2/4": {
    filename: "workspace.psd",
    // `octet-stream`, not `image/vnd.adobe.photoshop`: the catalog trusts a
    // claimed image type, and a fake PSD that claims to be an image is
    // correctly reported as corrupt after a fetch. Tier C is a property of the
    // attachment's declared type, so the fixture declares the honest one.
    contentType: "application/octet-stream",
    bytes: buildDemoPsd(),
  },
  "m5/2": {
    filename: "weekend-photos.zip",
    contentType: "application/zip",
    bytes: buildDemoZip({ entries: 201 }),
  },
};

/**
 * Demo mode's byte source. Registered by `demo.ts` at module load, so the
 * production path never sees it: the ingress falls back to the real
 * `/api/messages/:id/attachments/:partId` request when no provider is set.
 */
export const demoAttachmentProvider = (
  messageId: string,
  partId: string,
  _options: { signal?: AbortSignal } = {},
): Promise<Response> => {
  const fixture = demoAttachmentFixtures[`${messageId}/${partId}`];
  if (!fixture) return Promise.resolve(new Response(null, { status: 404 }));
  return Promise.resolve(
    new Response(fixture.bytes, {
      status: 200,
      headers: {
        "content-type": fixture.contentType,
        "content-length": String(fixture.bytes.byteLength),
      },
    }),
  );
};
