import { afterEach, describe, expect, it } from "vitest";
import { previewKindFor, tierFor } from "./attachments/catalog";
import { PreviewFailure } from "./attachments/failure";
import { openAttachmentResponse, setAttachmentResponseProvider } from "./attachments/ingress";
import { registerDemoAttachmentProvider } from "./demo";
import {
  buildDemoPdf,
  buildDemoPsd,
  buildDemoSvgWithScript,
  buildDemoText,
  buildDemoZip,
  demoAttachmentFixtures,
  demoAttachmentProvider,
} from "./demoAttachmentBytes";

/**
 * The demo fixtures are generated, so these assertions stand in for "someone
 * opened the file once": header, structure and determinism. A fixture that
 * drifts from what its surface expects fails here instead of in a browser.
 */

const latin1 = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

const u32 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 3] ?? 0) * 0x1000000);

const u16 = (bytes: Uint8Array, offset: number): number => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

describe("demo PDF fixture", () => {
  it("is a two-page PDF with a startxref and a valid cross-reference table", () => {
    const bytes = buildDemoPdf();
    const text = latin1(bytes);
    expect(text.startsWith("%PDF-1.7\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Count 2");
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(2);
    expect(text).toContain("Demo invoice - page one");
    expect(text).toContain("Demo invoice - page two");
    // A filled rectangle, so a blank canvas means the render failed rather
    // than "the page really is empty".
    expect(text).toContain("re f");

    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(Number.isFinite(startxref)).toBe(true);
    const table = text.slice(startxref);
    const head = "xref\n0 8\n";
    expect(table.startsWith(head)).toBe(true);
    // The xref record is a fixed-width format: 10-digit offset, space, 5-digit
    // generation, space, one type character, then a two-byte EOL.
    const records = table.slice(head.length);
    for (let index = 0; index < 8; index += 1) {
      const record = records.slice(index * 20, index * 20 + 20);
      expect(record, `record ${index}`).toMatch(/^\d{10} \d{5} [fn] \n$/);
      if (index === 0) expect(record.slice(11, 16)).toBe("65535");
      if (index === 0) continue;
      const offset = Number(record.slice(0, 10));
      // The offsets are the thing pdf.js uses; a wrong one is a broken file.
      expect(text.slice(offset).startsWith(`${index} 0 obj`), `object ${index}`).toBe(true);
    }
  });

  it("is byte-identical on every call", () => {
    expect(buildDemoPdf()).toEqual(buildDemoPdf());
  });
});

describe("demo ZIP fixture", () => {
  it("holds 201 stored entries and a matching end record", () => {
    const bytes = buildDemoZip({ entries: 201 });
    const tail = bytes.length - 22;
    expect(u32(bytes, tail)).toBe(0x06054b50);
    expect(u16(bytes, tail + 10)).toBe(201);
    expect(u16(bytes, tail + 8)).toBe(201);
    expect(u32(bytes, tail + 12)).toBeGreaterThan(0);

    const text = latin1(bytes);
    const countOf = (signature: string): number => text.split(signature).length - 1;
    const LOCAL_HEADER = "PK\u0003\u0004";
    expect(countOf(LOCAL_HEADER)).toBe(201);
    expect(countOf("PK\u0001\u0002")).toBe(201);
    expect(text).toContain("photo-001.jpg");
    expect(text).toContain("photo-201.jpg");

    // Every local header declares method 0 (stored): the fixture must never
    // cost the archive surface an inflation.
    const firstHeader = text.indexOf(LOCAL_HEADER);
    expect(u16(bytes, firstHeader + 8)).toBe(0);
  });

  it("is byte-identical on every call, timestamp included", () => {
    expect(buildDemoZip({ entries: 3 })).toEqual(buildDemoZip({ entries: 3 }));
  });
});

describe("the remaining fixtures", () => {
  it("ships an SVG that actually carries the payloads the sanitizer removes", () => {
    const text = latin1(buildDemoSvgWithScript());
    expect(text).toContain('width="320"');
    expect(text).toContain('height="200"');
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain('onload="alert(');
  });

  it("ships a PSD header that the catalog classifies as download-only", () => {
    const bytes = buildDemoPsd();
    expect(bytes).toHaveLength(26);
    expect(latin1(bytes.subarray(0, 4))).toBe("8BPS");
  });

  it("ships readable text", () => {
    expect(latin1(buildDemoText())).toContain("Demo notes");
  });
});

describe("the demo attachment provider", () => {
  it("classifies each fixture as the tier its demo case needs", () => {
    const expected: Record<string, [string, string]> = {
      "m2/2": ["pdf", "A"],
      "m2/3": ["image-vector", "A"],
      // Tier C: the drawer must not fetch it at all, which only holds when the
      // fixture does not claim an image type.
      "m2/4": ["fallback", "C"],
      "m5/2": ["archive", "B"],
    };
    for (const [key, [kind, tier]] of Object.entries(expected)) {
      const fixture = demoAttachmentFixtures[key]!;
      expect(previewKindFor(fixture), key).toBe(kind);
      expect(tierFor(previewKindFor(fixture)), key).toBe(tier);
    }
  });

  it("serves every fixture with its declared type and length", async () => {
    for (const [key, fixture] of Object.entries(demoAttachmentFixtures)) {
      const [messageId, partId] = key.split("/");
      const response = await demoAttachmentProvider(messageId!, partId!);
      expect(response.status, key).toBe(200);
      expect(response.headers.get("content-type"), key).toBe(fixture.contentType);
      expect(Number(response.headers.get("content-length")), key).toBe(fixture.bytes.byteLength);
      expect((await response.arrayBuffer()).byteLength, key).toBe(fixture.bytes.byteLength);
    }
  });

  it("answers 404 for a pair it does not know", async () => {
    const response = await demoAttachmentProvider("m99", "9");
    expect(response.status).toBe(404);
  });
});

/**
 * Regression: the fixtures must be enabled by the demo loader, never by merely
 * importing `demo.ts`. `CalendarDialog` imports `demoTranslate` from that module
 * statically, so a module-scope registration ran in real mode too, answering
 * 404 for every real `{messageId}/{partId}` — the drawer showed "无法预览该附件"
 * without issuing a single network request.
 */
describe("demo byte source registration", () => {
  afterEach(() => setAttachmentResponseProvider(null));

  it("stays disabled after demo.ts is imported", async () => {
    await expect(openAttachmentResponse("m2", "2", { cap: 16_000_000 })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("serves the fixtures once the loader registers it", async () => {
    registerDemoAttachmentProvider();
    const reply = await openAttachmentResponse("m2", "2", { cap: 16_000_000 });
    reply.dispose();
    expect(reply.response.status).toBe(200);
    expect(reply.response.headers.get("content-type")).toBe("application/pdf");
  });

  it("maps an unknown pair to a coded network failure, not an exception leak", async () => {
    registerDemoAttachmentProvider();
    await expect(openAttachmentResponse("m99", "9", { cap: 16_000_000 })).rejects.toBeInstanceOf(PreviewFailure);
    await expect(openAttachmentResponse("m99", "9", { cap: 16_000_000 })).rejects.toMatchObject({ code: "network" });
  });
});
