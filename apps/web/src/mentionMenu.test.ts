import { describe, expect, it } from "vitest";
import { mentionActiveIndex, mentionQuery } from "./mentionMenu";

describe("mentionQuery", () => {
  it("opens with a bare /@ prefix and returns an empty query", () => {
    expect(mentionQuery("/@")).toBe("");
    // A query of only whitespace is still an empty search (latest mail).
    expect(mentionQuery("/@ ")).toBe("");
  });

  it("returns the search term after the prefix", () => {
    expect(mentionQuery("/@invoice")).toBe("invoice");
    expect(mentionQuery("/@invoice draft")).toBe("invoice draft");
    expect(mentionQuery("/@ invoice")).toBe("invoice");
  });

  it("stays closed for plain text, slash commands, and non-prefix usage", () => {
    expect(mentionQuery("")).toBeNull();
    expect(mentionQuery("hello")).toBeNull();
    expect(mentionQuery("/memory")).toBeNull();
    expect(mentionQuery("see /@ elsewhere")).toBeNull();
  });

  it("is suppressed while streaming, dismissed, or in demo mode", () => {
    expect(mentionQuery("/@", { streaming: true })).toBeNull();
    expect(mentionQuery("/@", { dismissed: true })).toBeNull();
    expect(mentionQuery("/@", { demoMode: true })).toBeNull();
  });
});

describe("mentionActiveIndex", () => {
  it("clamps to the visible items and resets when there are none", () => {
    expect(mentionActiveIndex(["a", "b", "c"], 9)).toBe(2);
    expect(mentionActiveIndex(["a", "b", "c"], -3)).toBe(0);
    expect(mentionActiveIndex([], 2)).toBe(0);
  });
});