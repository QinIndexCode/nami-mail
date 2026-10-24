import { DECODE_DEADLINE_MS, MAX_RETAINED_CHARS } from "../budget";
import type { DecodeContext, PreviewDocument, PreviewInput } from "../document";
import { PreviewCanceled, PreviewFailure } from "../failure";

/** 64 KiB: enough to keep the per-chunk overhead invisible, small enough that a
 * cancellation or deadline check happens tens of times per second. */
const CHUNK_BYTES = 65_536;

type DecodedText = { text: string; shown: number; total: number; encoding: string };

function detectEncoding(bytes: Uint8Array): { encoding: string; offset: number } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf-16le", offset: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be", offset: 2 };
  return { encoding: "utf-8", offset: 0 };
}

/**
 * Streams bytes through a non-fatal decoder, keeping at most `MAX_RETAINED_CHARS`
 * code points but counting all of them.
 *
 * Counting and truncating by code point (not by UTF-16 units) is what keeps an
 * astral character from being split into two lone surrogates; `String#slice`
 * would do exactly that.
 */
export function decodeBytesToText(bytes: Uint8Array, ctx: DecodeContext): DecodedText {
  const { encoding, offset } = detectEncoding(bytes);
  const decoder = new TextDecoder(encoding, { fatal: false });
  const startedAt = ctx.now();
  let retained = "";
  let shown = 0;
  let total = 0;
  for (let start = offset; start < bytes.length; start += CHUNK_BYTES) {
    if (ctx.signal.aborted) throw new PreviewCanceled();
    if (ctx.now() - startedAt > ctx.deadlineMs) throw new PreviewFailure("timeout");
    const end = Math.min(start + CHUNK_BYTES, bytes.length);
    const chunk = decoder.decode(bytes.subarray(start, end), { stream: end < bytes.length });
    for (const codePoint of chunk) {
      total += 1;
      if (shown < MAX_RETAINED_CHARS) {
        retained += codePoint;
        shown += 1;
      }
    }
  }
  for (const codePoint of decoder.decode()) {
    total += 1;
    if (shown < MAX_RETAINED_CHARS) {
      retained += codePoint;
      shown += 1;
    }
  }
  return { text: retained, shown, total, encoding };
}

/**
 * text / code / (temporarily) markdown: one text surface, no HTML parsing.
 *
 * The message only promises what the architecture can keep: the retained prefix
 * is charged to the ledger at its UTF-16 size, which is exactly the `{count}`
 * code points the footer reports.
 */
export function decodeText(input: PreviewInput, ctx: DecodeContext): PreviewDocument {
  const decoded = decodeBytesToText(input.bytes, ctx);
  ctx.lease.charge(decoded.text.length * 2, "retained preview text");
  return {
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    surface: { surface: "text", text: decoded.text, shown: decoded.shown, total: decoded.total },
  };
}

/** The default cooperative deadline for the text-shaped decoders. */
export const textDecodeDeadlineMs = DECODE_DEADLINE_MS;
