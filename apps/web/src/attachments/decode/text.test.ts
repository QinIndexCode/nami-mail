// @vitest-environment node
import { describe, expect, it, vi, afterEach } from "vitest";
import { MAX_RETAINED_CHARS } from "../budget";
import { ResourceScope } from "../document";
import { MemoryLease } from "../budget";
import { PreviewFailure } from "../failure";
import { decodeBytesToText, decodeText } from "./text";
import type { DecodeContext, PreviewInput } from "../document";

const context = (overrides: Partial<DecodeContext> = {}): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
  ...overrides,
});

const input = (bytes: Uint8Array, filename = "notes.txt", kind: PreviewInput["kind"] = "text"): PreviewInput => ({
  kind,
  filename,
  contentType: "text/plain",
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("decodeBytesToText", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects the three BOMs and strips them", () => {
    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hello")]);
    const utf16le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const utf16be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
    expect(decodeBytesToText(utf8Bom, context())).toMatchObject({ text: "hello", encoding: "utf-8" });
    expect(decodeBytesToText(utf16le, context())).toMatchObject({ text: "hi", encoding: "utf-16le" });
    expect(decodeBytesToText(utf16be, context())).toMatchObject({ text: "hi", encoding: "utf-16be" });
  });

  it("replaces invalid bytes instead of throwing", () => {
    const bytes = new Uint8Array([0x68, 0xff, 0x69]);
    expect(() => decodeBytesToText(bytes, context())).not.toThrow();
    expect(decodeBytesToText(bytes, context()).text).toContain("h");
  });

  it("keeps exactly the limit and reports the rest as truncated", () => {
    const exact = decodeBytesToText(utf8("a".repeat(MAX_RETAINED_CHARS)), context());
    expect(exact.shown).toBe(MAX_RETAINED_CHARS);
    expect(exact.total).toBe(MAX_RETAINED_CHARS);
    const over = decodeBytesToText(utf8("a".repeat(MAX_RETAINED_CHARS + 1)), context());
    expect(over.shown).toBe(MAX_RETAINED_CHARS);
    expect(over.total).toBe(MAX_RETAINED_CHARS + 1);
  });

  it("keeps 64,000 astral characters whole and never splits a surrogate pair", () => {
    const decoded = decodeBytesToText(utf8("😀".repeat(MAX_RETAINED_CHARS)), context());
    expect(decoded.shown).toBe(MAX_RETAINED_CHARS);
    expect(decoded.text).toBe("😀".repeat(MAX_RETAINED_CHARS));
    expect(decoded.text.length).toBe(MAX_RETAINED_CHARS * 2);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(decoded.text)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(decoded.text)).toBe(false);
  });

  it("reports a deadline as timeout, not as a cancellation", () => {
    const controller = new AbortController();
    let calls = 0;
    const computeNow = () => {
      calls += 1;
      return calls * 10_000;
    };
    expect(() => decodeBytesToText(utf8("a".repeat(200_000)), context({ signal: controller.signal, now: computeNow, deadlineMs: 15_000 }))).toThrow(PreviewFailure);
    expect(controller.signal.aborted).toBe(false);
    try {
      decodeBytesToText(utf8("a".repeat(200_000)), context({ now: computeNow, deadlineMs: 15_000 }));
    } catch (error) {
      expect((error as PreviewFailure).code).toBe("timeout");
    }
  });
});

describe("decodeText", () => {
  it("returns a text surface charged at its UTF-16 size", () => {
    const lease = new MemoryLease();
    const bytes = utf8("héllo");
    const document = decodeText(input(bytes), context({ lease }));
    expect(document.surface).toMatchObject({ surface: "text", shown: 5, total: 5 });
    expect(lease.used).toBe("héllo".length * 2);
  });

  it("degrades markdown to the same text surface in S2", () => {
    const document = decodeText(input(utf8("# title"), "readme.md", "markdown"), context());
    expect(document.kind).toBe("markdown");
    expect(document.surface.surface).toBe("text");
  });
});
