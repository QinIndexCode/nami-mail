/**
 * Real-byte PDF fixtures for the preview tests.
 *
 * These are hand-assembled files with a correct xref table rather than mocked
 * document objects: pdf.js parses bytes, so a fixture that only exists in
 * JavaScript proves nothing about the parser path. The files are deliberately
 * tiny except where a test needs a size — the huge ones pad a real object
 * stream instead of pretending to be large.
 */

type PdfObject = string | { dict: string; stream: Uint8Array };

const encoder = new TextEncoder();

/** PDF string escaping: only `\`, `(` and `)` are special inside `(…)`. */
const escapePdfString = (value: string): string => value.replace(/[\\()]/g, (match) => `\\${match}`);

class PdfBuilder {
  private parts: Uint8Array[] = [];
  private length = 0;

  push(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  get offset(): number {
    return this.length;
  }

  finish(_root = 1): Uint8Array {
    const output = new Uint8Array(this.length);
    let cursor = 0;
    for (const part of this.parts) {
      output.set(part, cursor);
      cursor += part.byteLength;
    }
    return output;
  }
}

/** Assembles `%PDF-1.7` + objects + xref + trailer; object 1 is the catalog. */
function buildPdf(objects: PdfObject[]): Uint8Array {
  const builder = new PdfBuilder();
  builder.push("%PDF-1.7\n");
  // Binary comment marker: tells every consumer this is not a text file.
  builder.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(builder.offset);
    const number = index + 1;
    if (typeof object === "string") {
      builder.push(`${number} 0 obj\n${object}\nendobj\n`);
      return;
    }
    builder.push(`${number} 0 obj\n${object.dict}\nstream\n`);
    builder.push(object.stream);
    builder.push("\nendstream\nendobj\n");
  });

  const xrefOffset = builder.offset;
  builder.push(`xref\n0 ${objects.length + 1}\n`);
  builder.push("0000000000 65535 f \n");
  for (const offset of offsets) builder.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  builder.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return builder.finish();
}

const contentStream = (source: string): { dict: string; stream: Uint8Array } => {
  const bytes = encoder.encode(source);
  return { dict: `<< /Length ${bytes.byteLength} >>`, stream: bytes };
};

/** A `FlateDecode` image whose "pixels" are never actually decoded by tests. */
const imageObject = (width: number, height: number, extra = ""): { dict: string; stream: Uint8Array } => ({
  dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 2 ${extra}>>`,
  stream: new Uint8Array([0x78, 0x9c]),
});

const pageObject = (extra: string): string =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ${extra}>>`;

/** A JavaScript OpenAction that would fire `app.alert` if pdf.js ever ran it. */
export function makePdfWithOpenActionJs(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\);) >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    pageObject("/Contents 4 0 R "),
    contentStream("BT /F1 12 Tf (open action) Tj ET"),
  ]);
}

/** A 20,000 × 20,000 image XObject: over `maxImageSize` in both axes. */
export function makePdfWithHugeEmbeddedImage(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    imageObject(20_000, 20_000),
    contentStream("q 300 0 0 300 0 0 cm /Im0 Do Q"),
  ]);
}

/** A Link annotation with an external `URI` action: must never be launched. */
export function makePdfWithExternalUriAction({ uri }: { uri: string }): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    pageObject("/Annots [4 0 R] /Contents 5 0 R "),
    `<< /Type /Annot /Subtype /Link /Rect [0 0 200 200] /A << /S /URI /URI (${escapePdfString(uri)}) >> >>`,
    contentStream("BT /F1 12 Tf (external link) Tj ET"),
  ]);
}

/** A file attachment annotation: previewing it must not call `getAttachments()`. */
export function makePdfWithAttachment(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(secret.txt) 4 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    pageObject("/Contents 5 0 R "),
    "<< /Type /Filespec /F (secret.txt) /EF << /F 6 0 R >> >>",
    contentStream("BT /F1 12 Tf (attachment) Tj ET"),
    { dict: "<< /Type /EmbeddedFile /Length 5 >>", stream: encoder.encode("hello") },
  ]);
}

/**
 * A page that paints `count` large images. `padBytes` inflates the file to the
 * size the ledger cares about (the default is a little over 32 MiB) without
 * changing what pdf.js would have to decode.
 */
export function makePdfWithManyImages({
  count,
  width,
  height,
  padBytes = 34 * 1024 * 1024,
}: {
  count: number;
  width: number;
  height: number;
  padBytes?: number;
}): Uint8Array {
  const drawing = Array.from({ length: count }, (_, index) => `q 10 0 0 10 0 0 cm /Im${index} Do Q`).join("\n");
  // Padding lives inside the content stream as `%` comments: still a legal PDF,
  // still the same object count and offsets, but the file really is that big,
  // so the input-bytes budget is exercised with genuine bytes.
  const paddingLine = `%${"pad".repeat(512)}\n`;
  const padding = paddingLine.repeat(Math.ceil(padBytes / paddingLine.length));
  const contents = contentStream(`${padding}${drawing}`);
  const pageNumber = 4 + count;
  const contentsNumber = pageNumber + 1;
  const xobjects = Array.from({ length: count }, (_, index) => `/Im${index} ${4 + index} 0 R`).join(" ");
  const objects: PdfObject[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << ${xobjects} >> >> /Contents ${contentsNumber} 0 R >>`,
  ];
  for (let index = 0; index < count; index += 1) objects.push(imageObject(width, height));
  objects.push(contents);
  return buildPdf(objects);
}
/** A 1 × 1 image whose soft mask claims 20,000 × 20,000 pixels. */
export function makePdfWithHugeSoftMask({ width, height }: { width: number; height: number }): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    {
      dict: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 2 /SMask 6 0 R >>",
      stream: new Uint8Array([0x78, 0x9c]),
    },
    contentStream("q 300 0 0 300 0 0 cm /Im0 Do Q"),
    {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length 2 >>`,
      stream: new Uint8Array([0x78, 0x9c]),
    },
  ]);
}

/** All six fixtures with the size each one is expected to be under. */
export function pdfFixtures() {
  return {
    openActionJs: makePdfWithOpenActionJs(),
    hugeEmbeddedImage: makePdfWithHugeEmbeddedImage(),
    externalUri: makePdfWithExternalUriAction({ uri: "https://evil.example/track" }),
    attachment: makePdfWithAttachment(),
    manyImages: makePdfWithManyImages({ count: 100, width: 4096, height: 2048 }),
    hugeSoftMask: makePdfWithHugeSoftMask({ width: 20_000, height: 20_000 }),
  };
}
