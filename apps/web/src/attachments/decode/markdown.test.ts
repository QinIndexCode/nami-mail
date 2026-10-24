// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_BLOCKS, MAX_MARKDOWN_BYTES, MemoryLease } from "../budget";
import type { DecodeContext, PreviewInput } from "../document";
import { ResourceScope } from "../document";
import { countMarkdownBlocks, decodeMarkdown } from "./markdown";

const context = (): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
});

const input = (bytes: Uint8Array): PreviewInput => ({
  kind: "markdown",
  filename: "notes.md",
  contentType: "text/markdown",
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const blocks = (count: number): string => Array.from({ length: count }, () => "a").join("\n\n");

describe("countMarkdownBlocks", () => {
  it("counts blank-line separated blocks", () => {
    expect(countMarkdownBlocks("one\n\ntwo\n\nthree")).toBe(3);
    expect(countMarkdownBlocks("one\ntwo\n\nthree")).toBe(2);
    expect(countMarkdownBlocks("")).toBe(0);
  });

  it("treats a fenced block as one block, blank lines inside included", () => {
    expect(countMarkdownBlocks("```\n\n\n```")).toBe(1);
    expect(countMarkdownBlocks("intro\n\n```\na\n\nb\n```\n\noutro")).toBe(3);
  });
});

describe("decodeMarkdown", () => {
  it("keeps Markdown source verbatim and switches to the markdown surface", () => {
    const source = "# Title\n\n**bold** and [link](https://example.com)";
    const document = decodeMarkdown(input(utf8(source)), context());
    expect(document.surface.surface).toBe("markdown");
    if (document.surface.surface !== "markdown") return;
    expect(document.surface.text).toBe(source);
    expect(document.kind).toBe("markdown");
  });

  it("accepts exactly 8 MiB and degrades one byte over", () => {
    const atLimit = decodeMarkdown(input(new Uint8Array(MAX_MARKDOWN_BYTES)), context());
    expect(atLimit.surface.surface).toBe("markdown");

    const overLimit = decodeMarkdown(input(new Uint8Array(MAX_MARKDOWN_BYTES + 1)), context());
    expect(overLimit.surface).toEqual(expect.objectContaining({ surface: "download_only", reason: "size" }));
  });

  it("accepts 4,000 blocks and degrades 4,001", () => {
    const atLimit = decodeMarkdown(input(utf8(blocks(MAX_MARKDOWN_BLOCKS))), context());
    expect(atLimit.surface.surface).toBe("markdown");

    const overLimit = decodeMarkdown(input(utf8(blocks(MAX_MARKDOWN_BLOCKS + 1))), context());
    expect(overLimit.surface).toEqual(expect.objectContaining({ surface: "download_only", reason: "size" }));
  });
});
