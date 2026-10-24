import { MAX_MARKDOWN_BLOCKS, MAX_MARKDOWN_BYTES } from "../budget";
import type { DecodeContext, PreviewDocument, PreviewInput } from "../document";
import { asDownloadOnly } from "../document";
import { decodeText } from "./text";

/**
 * Markdown preview (plan §4.4).
 *
 * Decoding is still "bytes to text": the Markdown is *not* turned into HTML
 * here, and nothing in this module parses it. Two ceilings apply before the
 * renderer sees it — 8 MiB of source, then 4,000 top-level blocks — because a
 * 1 MiB file made of blank lines is a million blocks, and the renderer would
 * build a DOM node for each one.
 *
 * The block count is the only Markdown-aware code in the pipeline: a fence is
 * one block no matter how many blank lines it contains, and that is all the
 * accuracy the ceiling needs.
 */

/** Counts top-level blocks the way CommonMark opens them: blank line, fence, blank line. */
export function countMarkdownBlocks(text: string): number {
  let blocks = 0;
  let open = false;
  let fenced = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (fenced) {
      if (/^(```|~~~)/.test(trimmed)) {
        fenced = false;
        open = true;
      }
      continue;
    }
    if (/^(```|~~~)/.test(trimmed)) {
      if (!open) blocks += 1;
      fenced = true;
      open = true;
      continue;
    }
    if (trimmed === "") {
      open = false;
      continue;
    }
    if (!open) {
      blocks += 1;
      open = true;
    }
  }
  return blocks;
}

export function decodeMarkdown(input: PreviewInput, context: DecodeContext): PreviewDocument {
  if (input.bytes.byteLength > MAX_MARKDOWN_BYTES) {
    return asDownloadOnly(
      {
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
        surface: { surface: "text", text: "", shown: 0, total: 0 },
      },
      "size",
    );
  }

  const decoded = decodeText(input, context);
  if (decoded.surface.surface !== "text") return { ...decoded, kind: input.kind };

  if (countMarkdownBlocks(decoded.surface.text) > MAX_MARKDOWN_BLOCKS) {
    return asDownloadOnly(
      {
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
        surface: { surface: "text", text: "", shown: 0, total: 0 },
      },
      "size",
    );
  }

  return {
    ...decoded,
    kind: input.kind,
    surface: {
      surface: "markdown",
      text: decoded.surface.text,
      shown: decoded.surface.shown,
      total: decoded.surface.total,
    },
  };
}
