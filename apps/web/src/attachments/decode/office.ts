import {
  MAX_OFFICE_BLOCKS,
  MAX_OFFICE_CHARS,
  MAX_OFFICE_ELEMENTS,
  MAX_OOXML_ENTRIES,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_SHEET_SLOTS,
  MAX_UNZIPPED_BYTES,
  MAX_ZIP_ENTRY_BYTES,
  SHEET_SLOT_BYTES,
  type MemoryLease,
} from "../budget";
import type { Block, DecodeContext, PreviewDocument, PreviewInput, PreviewSurface, Sheet } from "../document";
import { asDownloadOnly } from "../document";
import { PreviewCanceled, PreviewFailure } from "../failure";
import { ZipReader } from "../zip/reader";

/**
 * Office decoders (plan §4.4).
 *
 * The container is read with `ZipReader`, never with a general-purpose unzip
 * library, and every XML part goes through the same three gates before a parser
 * sees it:
 *
 * 1. `<!DOCTYPE` is refused outright — that is billion-laughs, and refusing the
 *    declaration costs one string scan.
 * 2. More than `MAX_OFFICE_ELEMENTS` `<` characters degrades the document to a
 *    download card *before* `DOMParser` is constructed, so a 16 MiB part of
 *    `<w:p/>` cannot materialise millions of nodes.
 * 3. Blocks and retained characters are metered while walking the DOM; going
 *    over either ceiling is also a download card, not a failure.
 *
 * `vbaProject.bin` is never read: only the named parts below are extracted, so a
 * macro payload cannot reach a parser and does not count as "content".
 */

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const WORD_DOCUMENT = "word/document.xml";
const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS = "xl/sharedStrings.xml";

const SLIDE_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/;
const WORKSHEET_PATTERN = /^xl\/worksheets\/sheet(\d+)\.xml$/;

type Metered = { blocks: string[]; chars: number; slots: number; exceeded: boolean };

function pushBlock(meter: Metered, text: string): void {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return;
  meter.blocks.push(trimmed);
  meter.chars += trimmed.length;
  if (meter.blocks.length > MAX_OFFICE_BLOCKS || meter.chars > MAX_OFFICE_CHARS) meter.exceeded = true;
}

function hasDoctype(text: string): boolean {
  return /<!DOCTYPE/i.test(text);
}

function countElements(text: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x3c) total += 1;
    if (total > MAX_OFFICE_ELEMENTS) return total;
  }
  return total;
}

/**
 * Gate every part *before* the first `parseFromString`: the dense-part fixture
 * asserts zero parser constructions when one part is over the element ceiling,
 * which only holds if the guard is a pre-pass over all parts.
 */
function guardParts(parts: readonly { name: string; text: string }[]): "ok" | "download" {
  for (const part of parts) {
    if (hasDoctype(part.text)) throw new PreviewFailure("corrupt");
    if (countElements(part.text) > MAX_OFFICE_ELEMENTS) return "download";
  }
  return "ok";
}

function parsePart(name: string, text: string): Document {
  const parsed = new DOMParser().parseFromString(text, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length > 0 || parsed.documentElement?.nodeName === "parsererror") {
    throw new PreviewFailure("corrupt", { cause: new Error(`unparsable OOXML part: ${name}`) });
  }
  return parsed;
}

function paragraphText(element: Element, textTag: string, namespace: string): string {
  const pieces: string[] = [];
  for (const node of element.getElementsByTagNameNS(namespace, textTag)) {
    pieces.push(node.textContent ?? "");
  }
  return pieces.join("");
}

function baseDocument(input: PreviewInput): PreviewDocument {
  return {
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    surface: { surface: "text", text: "", shown: 0, total: 0 },
  };
}

async function readTextPart(
  reader: ZipReader,
  path: string,
  context: DecodeContext,
): Promise<string | null> {
  if (!reader.has(path)) return null;
  if (context.signal.aborted) throw new PreviewCanceled();
  const bytes = await reader.readEntry(path);
  context.lease.chargeText(bytes.byteLength);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function wordSurface(reader: ZipReader, input: PreviewInput, context: DecodeContext): Promise<PreviewSurface> {
  const xml = await readTextPart(reader, WORD_DOCUMENT, context);
  if (xml === null) throw new PreviewFailure("corrupt");
  if (guardParts([{ name: WORD_DOCUMENT, text: xml }]) === "download") {
    return asDownloadOnly(baseDocument(input), "size").surface;
  }
  const parsed = parsePart(WORD_DOCUMENT, xml);
  const meter: Metered = { blocks: [], chars: 0, slots: 0, exceeded: false };
  for (const paragraph of Array.from(parsed.getElementsByTagNameNS(WORD_NS, "p"))) {
    pushBlock(meter, paragraphText(paragraph, "t", WORD_NS));
    if (meter.exceeded) return asDownloadOnly(baseDocument(input), "size").surface;
  }
  const blocks: Block[] = meter.blocks.map((text) => ({ text }));
  return { surface: "blocks", blocks };
}

async function slidesSurface(reader: ZipReader, input: PreviewInput, context: DecodeContext): Promise<PreviewSurface> {
  const slides = reader.entries
    .filter((entry) => SLIDE_PATTERN.test(entry.path))
    .sort((left, right) => {
      const leftIndex = Number(SLIDE_PATTERN.exec(left.path)?.[1] ?? 0);
      const rightIndex = Number(SLIDE_PATTERN.exec(right.path)?.[1] ?? 0);
      return leftIndex - rightIndex;
    });
  if (slides.length === 0) throw new PreviewFailure("corrupt");

  const parts: { name: string; text: string }[] = [];
  for (const slide of slides) {
    const text = await readTextPart(reader, slide.path, context);
    if (text !== null) parts.push({ name: slide.path, text });
  }
  if (guardParts(parts) === "download") return asDownloadOnly(baseDocument(input), "size").surface;

  const meter: Metered = { blocks: [], chars: 0, slots: 0, exceeded: false };
  for (const part of parts) {
    const parsed = parsePart(part.name, part.text);
    for (const paragraph of Array.from(parsed.getElementsByTagNameNS(DRAWING_NS, "p"))) {
      pushBlock(meter, paragraphText(paragraph, "t", DRAWING_NS));
      if (meter.exceeded) return asDownloadOnly(baseDocument(input), "size").surface;
    }
  }
  const blocks: Block[] = meter.blocks.map((text) => ({ text }));
  return { surface: "blocks", blocks };
}

/**
 * Zero-based column position of a cell reference, or `MAX_SHEET_COLUMNS` when
 * the reference falls outside the retained window.
 *
 * Parsing stops at the window instead of running on: `r="ZZZZ1"` (475,254) and a
 * 300-letter reference (which overflows to `Infinity`) both have to leave the
 * caller with a small number, because the caller grows an array to this index.
 */
function columnIndex(reference: string | null): number {
  const letters = (reference ?? "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  if (!letters) return 0;
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
    // The running value is the 1-based column number: `AX` is the 50th and
    // still inside the window, so the sentinel must be strictly greater.
    if (index > MAX_SHEET_COLUMNS) return MAX_SHEET_COLUMNS;
  }
  return Math.max(0, index - 1);
}

function stringTable(xml: string | null): string[] {
  if (xml === null) return [];
  const parsed = parsePart(SHARED_STRINGS, xml);
  const values: string[] = [];
  for (const item of Array.from(parsed.getElementsByTagNameNS(SHEET_NS, "si"))) {
    values.push(paragraphText(item, "t", SHEET_NS));
  }
  return values;
}

/**
 * Retains at most the 200 × 50 window the renderer shows, charging every row
 * growth to the memory lease.
 *
 * Both ceilings used to live only in the renderer, which slices before drawing.
 * That kept the *display* bounded but not the allocation: a cell reference only
 * had to name a far column for the decoder to grow the row to that index, and
 * empty slots hold no text, so `MAX_OFFICE_CHARS` never saw them. Slots are
 * therefore counted and charged here, where the array grows.
 */
function worksheetRows(xml: string, shared: readonly string[], meter: Metered, lease: MemoryLease): string[][] {
  const parsed = parsePart("worksheet", xml);
  const rows: string[][] = [];
  for (const row of Array.from(parsed.getElementsByTagNameNS(SHEET_NS, "row"))) {
    if (rows.length >= MAX_SHEET_ROWS) break;
    const values: string[] = [];
    for (const cell of Array.from(row.getElementsByTagNameNS(SHEET_NS, "c"))) {
      const type = cell.getAttribute("t");
      const raw = cell.getElementsByTagNameNS(SHEET_NS, "v")[0]?.textContent ?? "";
      let value = raw;
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = paragraphText(cell, "t", SHEET_NS);
      const index = columnIndex(cell.getAttribute("r"));
      // Outside the retained window: the renderer would never draw this cell, so
      // there is nothing to grow for it.
      if (index >= MAX_SHEET_COLUMNS) continue;
      const growth = index + 1 - values.length;
      if (growth > 0) {
        if (meter.slots + growth > MAX_SHEET_SLOTS) {
          meter.exceeded = true;
          break;
        }
        // Charge before the allocation, as every other path in the ledger does.
        lease.charge(growth * SHEET_SLOT_BYTES, "sheet slots");
        meter.slots += growth;
        while (values.length < index) values.push("");
      }
      values[index] = value;
      meter.chars += value.length;
      if (meter.chars > MAX_OFFICE_CHARS) meter.exceeded = true;
    }
    rows.push(values);
    if (meter.exceeded) break;
  }
  return rows;
}

async function sheetSurface(reader: ZipReader, input: PreviewInput, context: DecodeContext): Promise<PreviewSurface> {
  const workbookXml = await readTextPart(reader, WORKBOOK, context);
  if (workbookXml === null) throw new PreviewFailure("corrupt");
  const relsXml = await readTextPart(reader, WORKBOOK_RELS, context);
  const sharedXml = await readTextPart(reader, SHARED_STRINGS, context);

  // Every worksheet is read before the first parse, so the element-ceiling guard
  // can run as a single pre-pass across all parts. Parsing `workbook.xml` first
  // would mean one `DOMParser` construction before a dense sheet is refused.
  const byPattern = reader.entries
    .filter((entry) => WORKSHEET_PATTERN.test(entry.path))
    .map((entry) => entry.path)
    .sort((left, right) => Number(WORKSHEET_PATTERN.exec(left)?.[1]) - Number(WORKSHEET_PATTERN.exec(right)?.[1]));
  const worksheetParts: { name: string; text: string }[] = [];
  for (const path of byPattern) {
    const text = await readTextPart(reader, path, context);
    if (text !== null) worksheetParts.push({ name: path, text });
  }

  const parts: { name: string; text: string }[] = [
    { name: WORKBOOK, text: workbookXml },
    ...(sharedXml === null ? [] : [{ name: SHARED_STRINGS, text: sharedXml }]),
    ...worksheetParts,
  ];
  if (guardParts(parts) === "download") return asDownloadOnly(baseDocument(input), "size").surface;

  const workbook = parsePart(WORKBOOK, workbookXml);
  const relationshipTargets = new Map<string, string>();
  if (relsXml !== null) {
    const rels = parsePart(WORKBOOK_RELS, relsXml);
    for (const relationship of Array.from(rels.getElementsByTagName("Relationship"))) {
      const id = relationship.getAttribute("Id");
      const target = relationship.getAttribute("Target");
      if (!id || !target) continue;
      const normalized = target.replace(/^\//, "");
      relationshipTargets.set(id, normalized.startsWith("xl/") ? normalized : `xl/${normalized}`);
    }
  }

  const declared = Array.from(workbook.getElementsByTagNameNS(SHEET_NS, "sheet")).map((sheet) => {
    const id = sheet.getAttributeNS(RELATIONSHIP_NS, "id") ?? sheet.getAttribute("r:id") ?? "";
    const target = relationshipTargets.get(id);
    return { name: sheet.getAttribute("name") ?? "", path: target ?? "" };
  });

  const available = new Map(worksheetParts.map((part) => [part.name, part.text]));
  const ordered = declared.length > 0
    ? declared.map((sheet, index) => ({ name: sheet.name, path: sheet.path || byPattern[index] || "" }))
    : byPattern.map((path, index) => ({ name: `Sheet ${index + 1}`, path }));
  if (ordered.length === 0) throw new PreviewFailure("corrupt");

  const shared = stringTable(sharedXml);
  const meter: Metered = { blocks: [], chars: 0, slots: 0, exceeded: false };
  const sheets: Sheet[] = [];
  for (const [index, sheet] of ordered.entries()) {
    const xml = available.get(sheet.path);
    if (xml === undefined) continue;
    sheets.push({ name: sheet.name || `Sheet ${index + 1}`, rows: worksheetRows(xml, shared, meter, context.lease) });
    if (meter.exceeded) return asDownloadOnly(baseDocument(input), "size").surface;
  }
  if (sheets.length === 0) throw new PreviewFailure("corrupt");
  return { surface: "sheet", sheets };
}

export async function decodeOffice(input: PreviewInput, context: DecodeContext): Promise<PreviewDocument> {
  const reader = ZipReader.open(input.bytes, {
    maxEntries: MAX_OOXML_ENTRIES,
    signal: context.signal,
    now: context.now,
    deadlineMs: context.deadlineMs,
    maxEntryBytes: MAX_ZIP_ENTRY_BYTES,
    maxTotalBytes: MAX_UNZIPPED_BYTES,
  });
  if (reader.entries.some((entry) => entry.encrypted)) throw new PreviewFailure("encrypted");

  let surface: PreviewSurface;
  switch (input.kind) {
    case "office-word":
      surface = await wordSurface(reader, input, context);
      break;
    case "office-sheet":
      surface = await sheetSurface(reader, input, context);
      break;
    case "office-slides":
      surface = await slidesSurface(reader, input, context);
      break;
    default:
      throw new PreviewFailure("unsupported");
  }
  return { ...baseDocument(input), surface };
}
