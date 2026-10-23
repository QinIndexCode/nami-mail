// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MAX_OOXML_ENTRIES, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, MAX_SHEET_SLOTS, SHEET_SLOT_BYTES } from "../budget";
import { MemoryLease } from "../budget";
import type { DecodeContext, PreviewInput } from "../document";
import { ResourceScope } from "../document";
import { encodeFixtureText, makeDocx, makeDocxBillionLaughs, makePptx, makeXlsx, makeZip, makeZipEncrypted, type ZipEntryInput } from "../testing/fixtures";
import { decodeOffice } from "./office";
import { decodeAttachment } from "./index";

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

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

  it("does not let a far cell reference grow the row past the retained window", async () => {
    const fixture = await makeZip([
      { name: "xl/workbook.xml", data: encodeFixtureText(`<workbook xmlns="${SHEET_NS}"/>`) },
      {
        name: "xl/worksheets/sheet1.xml",
        data: encodeFixtureText(
          `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="ZZZZ1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>`,
        ),
      },
    ]);
    const lease = new MemoryLease(64 * 1024);
    const document = await decodeOffice(input(fixture.bytes, "office-sheet", "sparse.xlsx"), context({ lease }));
    expect(document.surface.surface).toBe("sheet");
    if (document.surface.surface !== "sheet") return;
    // The out-of-window cell is dropped; its in-window neighbour keeps column B.
    expect(document.surface.sheets[0]?.rows).toEqual([["", "2"]]);
    const slots = document.surface.sheets.flatMap((sheet) => sheet.rows).reduce((total, row) => total + row.length, 0);
    expect(slots).toBeLessThanOrEqual(MAX_SHEET_ROWS * MAX_SHEET_COLUMNS);
    expect(lease.used).toBeGreaterThanOrEqual(slots * SHEET_SLOT_BYTES);
  });

  it("degrades a workbook whose sheets together exceed the retained slot ceiling", async () => {
    const perSheetSlots = MAX_SHEET_ROWS * MAX_SHEET_COLUMNS;
    const count = Math.ceil(MAX_SHEET_SLOTS / perSheetSlots) + 1;
    const declared = Array.from({ length: count }, (_, index) => `<sheet name="S${index + 1}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
    const relationships = Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`);
    const worksheet = `<worksheet xmlns="${SHEET_NS}"><sheetData>${Array.from(
      { length: MAX_SHEET_ROWS },
      (_, index) => `<row r="${index + 1}"><c r="AX${index + 1}"><v>1</v></c></row>`,
    ).join("")}</sheetData></worksheet>`;
    const fixture = await makeZip([
      {
        name: "xl/workbook.xml",
        data: encodeFixtureText(
          `<workbook xmlns="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${declared.join("")}</sheets></workbook>`,
        ),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: encodeFixtureText(`<Relationships xmlns="${RELS_NS}">${relationships.join("")}</Relationships>`),
      },
      ...Array.from({ length: count }, (_, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        data: encodeFixtureText(worksheet),
      })),
    ]);
    const document = await decodeOffice(input(fixture.bytes, "office-sheet", "wide.xlsx"), context());
    expect(document.surface.surface).toBe("download_only");
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
