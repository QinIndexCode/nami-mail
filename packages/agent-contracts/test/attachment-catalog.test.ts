import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTACHMENT_KINDS,
  attachmentKinds,
  attachmentKindsJson,
  classifyAttachmentKind,
  codeTextExtensions,
  extensionKinds,
  markdownExtensions,
  mediaKind,
  plainTextExtensions,
  readableTextExtensions,
  sniffSignature,
  type AttachmentKind,
} from "../src/index.js";

/** Number of entries mapping to one kind (the curated rows only, until `code`). */
function curatedCountByKind(kind: AttachmentKind): number {
  return Object.values(extensionKinds).filter((value) => value === kind).length;
}

test("attachment kinds are the nine families, and both spellings are one array", () => {
  assert.deepEqual(attachmentKinds, ["archive", "code", "document", "image", "media", "pdf", "spreadsheet", "text", "other"]);
  assert.equal(new Set(attachmentKinds).size, 9);
  // Identity, not equality: the server filters on ATTACHMENT_KINDS while the
  // UI renders attachmentKinds; two copies could drift, one object cannot.
  assert.equal(ATTACHMENT_KINDS, attachmentKinds);
});

test("the extension table covers every kind and nothing else", () => {
  // 8 archives + 19 documents + 13 images + 21 audio/video + 5 spreadsheets
  // + 3 text + 1 PDF + 68 code/config = 138. A colliding extension would make
  // the object smaller than this sum, which is exactly what this pins.
  assert.equal(Object.keys(extensionKinds).length, 138);
  assert.equal(codeTextExtensions.size, 68);
  assert.equal(Object.keys(extensionKinds).length, 70 + codeTextExtensions.size);
  assert.equal(curatedCountByKind("archive"), 8);
  assert.equal(curatedCountByKind("document"), 19);
  assert.equal(curatedCountByKind("image"), 13);
  assert.equal(curatedCountByKind("media"), 21);
  assert.equal(curatedCountByKind("spreadsheet"), 5);
  assert.equal(curatedCountByKind("text"), 3);
  assert.equal(curatedCountByKind("pdf"), 1);
  assert.equal(curatedCountByKind("code"), 68);

  for (const kind of attachmentKinds) {
    if (kind === "other") continue;
    assert.ok(Object.values(extensionKinds).includes(kind), `${kind} has no extension in the table`);
  }
  for (const extension of Object.keys(extensionKinds)) {
    assert.match(extension, /^[a-z0-9]{1,8}$/, `${extension} is not a normalized extension key`);
  }
});

test("curated rows win over the code expansion", () => {
  for (const extension of codeTextExtensions) {
    assert.equal(extensionKinds[extension], "code", `${extension} must stay classified as code`);
  }
  // These look like code but are curated rows: a spreadsheet and a document.
  assert.equal(extensionKinds.csv, "spreadsheet");
  assert.equal(extensionKinds.md, "text");
  assert.equal(extensionKinds.rtf, "document");
});

test("text extension sets keep their documented widths and nest into readable", () => {
  assert.equal(plainTextExtensions.size, 7);
  assert.equal(markdownExtensions.size, 3);
  assert.equal(readableTextExtensions.size, 11);
  for (const extension of plainTextExtensions) {
    assert.ok(readableTextExtensions.has(extension), `${extension} must be readable`);
  }
  for (const extension of markdownExtensions) {
    assert.ok(readableTextExtensions.has(extension), `${extension} must be readable`);
  }
  // RTF is readable (it is text) but not plain text: raw control words are not
  // something a preview should display.
  assert.ok(readableTextExtensions.has("rtf"));
  assert.ok(!plainTextExtensions.has("rtf"));
  assert.ok(!markdownExtensions.has("rtf"));
});

test("classifyAttachmentKind prefers a curated extension over the stored MIME type", () => {
  assert.equal(classifyAttachmentKind("report.PDF", "application/octet-stream"), "pdf");
  assert.equal(classifyAttachmentKind(".hidden.png", ""), "image");
  assert.equal(classifyAttachmentKind("archive.tar.gz", ""), "archive");
  assert.equal(classifyAttachmentKind("script.py", "text/plain"), "code");
  assert.equal(classifyAttachmentKind("data.csv", "text/csv"), "spreadsheet");
  assert.equal(classifyAttachmentKind("  spaced.docx  ", "text/plain"), "document");
});

test("classifyAttachmentKind falls back to the MIME type only for unknown extensions", () => {
  assert.equal(classifyAttachmentKind("blob", "application/pdf"), "pdf");
  assert.equal(classifyAttachmentKind("blob", "image/heic"), "image");
  assert.equal(classifyAttachmentKind("blob", "video/mp4"), "media");
  assert.equal(classifyAttachmentKind("blob", "application/x-7z-compressed"), "archive");
  assert.equal(classifyAttachmentKind("blob", "application/vnd.ms-excel"), "spreadsheet");
  assert.equal(classifyAttachmentKind("blob", "text/javascript"), "code");
  assert.equal(classifyAttachmentKind("blob", "application/graphql"), "other");
  assert.equal(classifyAttachmentKind("blob", "text/plain"), "text");
  assert.equal(classifyAttachmentKind("blob", "application/msword"), "document");
  assert.equal(classifyAttachmentKind("blob", "application/octet-stream"), "other");
  assert.equal(classifyAttachmentKind("blob", ""), "other");
});

test("mediaKind splits the media row into audio and video", () => {
  assert.equal(mediaKind("podcast.mp3"), "audio");
  assert.equal(mediaKind("recording.WAV"), "audio");
  assert.equal(mediaKind("clip.mpg"), "video");
  assert.equal(mediaKind("clip.ogv"), "video");
  assert.equal(mediaKind("blob", "audio/mpeg"), "audio");
  assert.equal(mediaKind("blob", "video/webm"), "video");
  assert.equal(mediaKind("report.pdf"), null);
  assert.equal(mediaKind("blob"), null);

  for (const extension of Object.keys(extensionKinds)) {
    if (extensionKinds[extension] !== "media") continue;
    assert.notEqual(mediaKind(`file.${extension}`), null, `${extension} is media but has no audio/video family`);
  }
});

test("attachmentKindsJson deduplicates kinds in first-seen order", () => {
  assert.equal(attachmentKindsJson([]), "[]");
  assert.equal(
    attachmentKindsJson([
      { filename: "b.png", contentType: "" },
      { filename: "a.pdf", contentType: "" },
      { filename: "c.png", contentType: "" },
    ]),
    JSON.stringify(["image", "pdf"]),
  );

  // One representative per kind (untagged files fall into "other") must
  // serialize to exactly the canonical vocabulary, which is what the SQL
  // LIKE filters match on.
  const representativePerKind = attachmentKinds.map((kind) => {
    const extension = Object.keys(extensionKinds).find((candidate) => extensionKinds[candidate] === kind);
    return { filename: extension ? `file.${extension}` : "file", contentType: "" };
  });
  assert.equal(attachmentKindsJson(representativePerKind), JSON.stringify(attachmentKinds));
});

/** Minimal ZIP local file header carrying one entry name. */
function zipBytes(entryName: string): Uint8Array {
  const name = new TextEncoder().encode(entryName);
  const bytes = new Uint8Array(30 + name.length);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  bytes[26] = name.length & 0xff;
  bytes[27] = (name.length >> 8) & 0xff;
  bytes.set(name, 30);
  return bytes;
}

test("sniffSignature identifies containers from their leading bytes", () => {
  assert.equal(sniffSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x37])), "pdf");
  assert.equal(sniffSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(sniffSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(sniffSignature(new TextEncoder().encode("GIF87a")), "gif");
  assert.equal(sniffSignature(new TextEncoder().encode("GIF89a")), "gif");
  assert.equal(sniffSignature(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), "webp");
  assert.equal(sniffSignature(new Uint8Array([0x42, 0x4d, 0x00, 0x00])), "bmp");
  assert.equal(sniffSignature(zipBytes("word/document.xml")), "zip");
  assert.equal(sniffSignature(zipBytes("[Content_Types].xml")), "ooxml");
  assert.equal(sniffSignature(new Uint8Array()), null);
  assert.equal(sniffSignature(new TextEncoder().encode("plain text, not a container")), null);
  // A bare RIFF is WAV/AVI, not WebP; matching only the first four bytes would
  // misroute an audio file into the image surface.
  assert.equal(sniffSignature(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WAVEfmt ")), null);
});

test("sniffSignature tolerates a junk prefix before a PDF header, but only within the window", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n");
  const withPrefix = (prefixLength: number): Uint8Array => {
    const bytes = new Uint8Array(prefixLength + pdf.length);
    bytes.set(new TextEncoder().encode("x".repeat(prefixLength)), 0);
    bytes.set(pdf, prefixLength);
    return bytes;
  };
  assert.equal(sniffSignature(withPrefix(64)), "pdf");
  assert.equal(sniffSignature(withPrefix(1019)), "pdf");
  // Beyond the 1 KiB window the header is treated as absent: a file that only
  // looks like a PDF deep inside is not a PDF for the preview gate.
  assert.equal(sniffSignature(withPrefix(1024)), null);
});
