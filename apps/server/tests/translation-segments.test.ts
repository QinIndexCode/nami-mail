import { describe, expect, it } from "vitest";
import { buildTranslationBlocks, MAX_BLOCK_CHARS, SEGMENT_SEPARATOR, splitTranslatedBlock } from "../src/translation-segments.js";

describe("buildTranslationBlocks", () => {
  it("merges consecutive short segments into one block", () => {
    const merged = buildTranslationBlocks(["a", "b", "c"]);
    expect(merged).toEqual([
      { indices: [0, 1, 2], text: `a\nb\nc` },
    ]);
  });

  it("splits a block when the merged length exceeds MAX_BLOCK_CHARS", () => {
    const long = "x".repeat(MAX_BLOCK_CHARS);
    const blocks = buildTranslationBlocks([long, "y", "z"]);
    // First segment alone exceeds the cap, so it forms its own block.
    expect(blocks[0]).toEqual({ indices: [0], text: long });
    // "y" + "z" merge.
    expect(blocks[1]).toEqual({ indices: [1, 2], text: `y${SEGMENT_SEPARATOR}z` });
  });

  it("handles empty segment lists", () => {
    expect(buildTranslationBlocks([])).toEqual([]);
  });
});

describe("splitTranslatedBlock", () => {
  it("maps parts 1:1 back to segments when the separator survives", () => {
    const target: string[] = new Array(3);
    splitTranslatedBlock("A\nB\nC", [0, 1, 2], target);
    expect(target).toEqual(["A", "B", "C"]);
  });

  it("distributes the whole block when the engine collapsed the separator", () => {
    const target: string[] = new Array(2);
    splitTranslatedBlock("Collapsed", [0, 1], target);
    expect(target).toEqual(["Collapsed", "Collapsed"]);
  });

  it("fills missing trailing parts with the whole block", () => {
    const target: string[] = new Array(3);
    splitTranslatedBlock("A\nB", [0, 1, 2], target);
    expect(target).toEqual(["A", "B", "A\nB"]);
  });
});
