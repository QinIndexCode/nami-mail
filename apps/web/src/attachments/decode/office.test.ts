// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MAX_OOXML_ENTRIES } from "../budget";
import { MemoryLease } from "../budget";
import type { DecodeContext, PreviewInput } from "../document";
import { ResourceScope } from "../document";
import { encodeFixtureText, makeDocx, makeDocxBillionLaughs, makePptx, makeXlsx, makeZipEncrypted, type ZipEntryInput } from "../testing/fixtures";
import { decodeOffice } from "./office";
import { decodeAttachment } from "./index";

const context = (overrides: Partial<DecodeContext> = {}): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
  ...overrides,
});

const input = (bytes: Uint8Array, kind: PreviewInput["kind"], filename: string): PreviewInput => ({
  kind,
  filename,
  contentType: "application/vnd.openxmlformats-officedocument",
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

const extras = (count: number): ZipEntryInput[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `word/media/image-${index}.bin`,
    data: encodeFixtureText(`asset ${index}`),
  }));

describe("decodeOffice", () => {
  it("extracts Word paragraphs as plain-text blocks", async () => {
    const fixture = await makeDocx();
    const document = await decodeOffice(input(fixture.bytes, "office-word", "notes.docx"), context());
    expect(document.surface.surface).toBe("blocks");
    if (document.surface.surface !== "blocks") return;
    expect(document.surface.blocks.map((block) => block.text)).toEqual(["Hello from the fixture docx"]);
  });

  it("reads sheets through the shared string table, keeping column positions", async () => {
    const fixture = await makeXlsx();
    const document = await decodeOffice(input(fixture.bytes, "office-sheet", "book.xlsx"), context());
    expect(document.surface.surface).toBe("sheet");
    if (document.surface.surface !== "sheet") return;
    expect(document.surface.sheets).toHaveLength(1);
    expect(document.surface.sheets[0]?.name).toBe("Sheet1");
    expect(document.surface.sheets[0]?.rows).toEqual([
      ["Name", "42"],
      ["Alice", "7"],
    ]);
  });

  it("extracts one block per slide paragraph", async () => {
    const fixture = await makePptx();
    const document = await decodeOffice(input(fixture.bytes, "office-slides", "deck.pptx"), context());
    expect(document.surface.surface).toBe("blocks");
    if (document.surface.surface !== "blocks") return;
    expect(document.surface.blocks.map((block) => block.text)).toEqual(["Slide title", "Slide body"]);
  });

  it("refuses a DOCTYPE before the parser is ever constructed", async () => {
    const fixture = await makeDocxBillionLaughs();
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    await expect(decodeOffice(input(fixture.bytes, "office-word", "bomb.docx"), context())).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("degrades a dense part to the download card without parsing anything", async () => {
    const dense = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${"<w:p/>".repeat(50_001)}</w:body></w:document>`;
    const fixture = await makeDocx({ documentXml: dense });
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    const document = await decodeOffice(input(fixture.bytes, "office-word", "dense.docx"), context());
    expect(document.surface.surface).toBe("download_only");
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses an encrypted package without decrypting", async () => {
    const fixture = await makeZipEncrypted();
    await expect(decodeOffice(input(fixture.bytes, "office-word", "secret.docx"), context())).rejects.toMatchObject({
      code: "encrypted",
    });
  });

  it("holds the package to the 2,000-entry ceiling", async () => {
    const atLimit = await makeDocx({ extraEntries: extras(MAX_OOXML_ENTRIES - 3) });
    await expect(decodeOffice(input(atLimit.bytes, "office-word", "big.docx"), context())).resolves.toBeTruthy();

    const overLimit = await makeDocx({ extraEntries: extras(MAX_OOXML_ENTRIES - 2) });
    await expect(decodeOffice(input(overLimit.bytes, "office-word", "bigger.docx"), context())).rejects.toMatchObject({
      code: "too_many_entries",
    });
  });

  it("ignores a macro payload instead of scanning or parsing it", async () => {
    const fixture = await makeDocx({
      extraEntries: [
        {
          name: "word/vbaProject.bin",
          data: encodeFixtureText('<!DOCTYPE x [<!ENTITY a "b">]><script>alert(1)</script>'),
        },
      ],
    });
    const document = await decodeOffice(input(fixture.bytes, "office-word", "macro.docx"), context());
    expect(document.surface.surface).toBe("blocks");
  });

  it("rejects a package whose XML does not parse", async () => {
    const fixture = await makeDocx({ documentXml: "<w:document><unclosed>" });
    await expect(decodeOffice(input(fixture.bytes, "office-word", "broken.docx"), context())).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("is the decoder decodeAttachment routes office kinds to", async () => {
    const fixture = await makeDocx();
    const document = await decodeAttachment(input(fixture.bytes, "office-word", "notes.docx"), context());
    expect(document.surface.surface).toBe("blocks");
  });
});
