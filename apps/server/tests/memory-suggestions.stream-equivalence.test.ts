import { describe, expect, it } from "vitest";
import { filterMemorySuggestionChunk, stripMemorySuggestions } from "../src/agent/memory-suggestions.js";

/**
 * Reproduction: the streamed reply and the persisted transcript must contain
 * the same characters. The user reports that during a reply the transcript is
 * missing characters, and that reloading shows more of them.
 *
 * Feed the model output through the real streaming filter exactly as
 * run-engine.ts:1164-1167 does (chunk by chunk, threading `carry`), then
 * compare the concatenation against what the persisted path produces from the
 * very same raw text (`stripMemorySuggestions`, run-engine.ts:1415).
 */
function streamed(raw: string, chunkSize: number): string {
  let out = "";
  let carry = "";
  for (let index = 0; index < raw.length; index += chunkSize) {
    const result = filterMemorySuggestionChunk(raw.slice(index, index + chunkSize), carry);
    carry = result.carry;
    out += result.text;
  }
  // The engine drops the final carry only when it closes; it is flushed the
  // same way the last complete line would be.
  return carry && !/^[ \t]*MEMORY_SUGGEST:/.test(carry) ? out + carry : out;
}

/**
 * A stream never learns which chunk is the last one, so the filter cannot
 * apply the `trim()` the persisted path applies at the end. Trailing
 * whitespace is therefore the only tolerated difference; every character in
 * between must match byte for byte, otherwise characters are lost again.
 */
function sameCharacters(streamedText: string, persistedText: string): void {
  expect(streamedText.replace(/\s+$/, "")).toBe(persistedText.replace(/\s+$/, ""));
}

describe("streamed transcript equals persisted transcript", () => {
  it("keeps the newline between two paragraphs", () => {
    const raw = "第一段第一行\n第一段第二行\n\n第二段第一行\n";
    sameCharacters(streamed(raw, 6), stripMemorySuggestions(raw));
  });

  it("keeps every newline when chunks are split right after them", () => {
    const raw = "alpha\nbeta\ngamma\ndelta\n";
    // A provider that emits one token per chunk splits exactly on the
    // newlines — the shape that loses the most characters today.
    sameCharacters(streamed(raw, 1), stripMemorySuggestions(raw));
  });

  it("loses no characters for a long reply delivered in small chunks", () => {
    const raw = Array.from({ length: 40 }, (_, index) => `第${index}行内容`).join("\n") + "\n";
    sameCharacters(streamed(raw, 3), stripMemorySuggestions(raw));
  });

  it("still strips a complete MEMORY_SUGGEST line from both paths", () => {
    const raw = "回答正文\nMEMORY_SUGGEST: 用户偏好简洁回复\n";
    sameCharacters(streamed(raw, 5), stripMemorySuggestions(raw));
    expect(stripMemorySuggestions(raw)).toBe("回答正文");
  });

  it("reproduces a marker-free reply byte for byte", () => {
    // Stronger than comparing against the persisted path: with no marker line
    // there is nothing to strip, so the filter must be a pass-through.
    const raw = "标题\n\n第一行\n第二行\n\n结尾。";
    expect(streamed(raw, 1)).toBe(raw);
    expect(streamed(raw, raw.length)).toBe(raw);
  });
});