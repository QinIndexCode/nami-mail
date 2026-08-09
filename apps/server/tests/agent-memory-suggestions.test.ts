import { describe, expect, it } from "vitest";
import {
  extractMemorySuggestions,
  filterMemorySuggestionChunk,
  stripMemorySuggestions,
} from "../src/agent/memory-suggestions.js";

describe("memory suggestions", () => {
  it("extracts and strips a trailing marker line from a full reply", () => {
    const reply = ["I will keep that in mind.", "", "MEMORY_SUGGEST: User prefers English replies"].join("\n");
    expect(extractMemorySuggestions(reply)).toEqual(["User prefers English replies"]);
    expect(stripMemorySuggestions(reply)).toBe("I will keep that in mind.");
  });

  it("ignores mid-reply markers and empty markers", () => {
    const reply = ["MEMORY_SUGGEST: one", "body text", "MEMORY_SUGGEST:"].join("\n");
    expect(extractMemorySuggestions(reply)).toEqual([]);
    expect(stripMemorySuggestions(reply)).toBe("body text");
  });

  it("caps suggestions at one per turn", () => {
    const reply = ["body", "MEMORY_SUGGEST: one", "MEMORY_SUGGEST: two"].join("\n");
    expect(extractMemorySuggestions(reply)).toEqual(["two"]);
    expect(stripMemorySuggestions(reply)).toBe("body");
  });

  it("returns the text unchanged when no marker is present", () => {
    const text = "A normal answer.\nSecond line.";
    expect(extractMemorySuggestions(text)).toEqual([]);
    expect(stripMemorySuggestions(text)).toBe(text);
  });

  it("filters complete marker lines from streamed chunks", () => {
    const first = filterMemorySuggestionChunk("normal text\nMEMORY_SUGGEST: keep this\nmore");
    expect(first.text).toBe("normal text\nmore");
    expect(first.carry).toBe("");
    expect(filterMemorySuggestionChunk("plain chunk").text).toBe("plain chunk");
  });

  it("threads marker prefixes split across chunk boundaries without flashing", () => {
    const first = filterMemorySuggestionChunk("reply end\nMEMORY_SUGGEST:");
    expect(first.text).toBe("reply end");
    expect(first.carry).toBe("MEMORY_SUGGEST:");

    const second = filterMemorySuggestionChunk(" keep this", first.carry);
    expect(second.text).toBe("");
    expect(second.carry).toBe("MEMORY_SUGGEST: keep this");

    const third = filterMemorySuggestionChunk("\nthanks", second.carry);
    expect(third.text).toBe("thanks");
    expect(third.carry).toBe("");
  });

  it("drops an unclosed marker line when the stream ends", () => {
    const first = filterMemorySuggestionChunk("done\nMEMORY_SUGGEST: half");
    expect(first.text).toBe("done");
    expect(first.carry).toBe("MEMORY_SUGGEST: half");
    const second = filterMemorySuggestionChunk("", first.carry);
    expect(second.text).toBe("");
  });
});
