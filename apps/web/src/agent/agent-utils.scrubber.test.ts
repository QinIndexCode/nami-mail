import { describe, expect, it } from "vitest";
import { findNearestScrubberIndex } from "./agent-utils";

describe("findNearestScrubberIndex", () => {
  it("returns 0 when there is only 1 or 0 messages", () => {
    expect(findNearestScrubberIndex(100, 0, 50, 12)).toBe(0);
    expect(findNearestScrubberIndex(100, 1, 50, 12)).toBe(0);
  });

  it("finds the exact bar index when pointer aligns with a bar", () => {
    // viewport = 20, barGap = 12
    // index 0 -> y = 20
    // index 1 -> y = 32
    // index 2 -> y = 44
    expect(findNearestScrubberIndex(20, 3, 20, 12)).toBe(0);
    expect(findNearestScrubberIndex(32, 3, 20, 12)).toBe(1);
    expect(findNearestScrubberIndex(44, 3, 20, 12)).toBe(2);
  });

  it("finds the nearest bar when pointer is between bars", () => {
    // index 0 at 20, index 1 at 32 (midpoint is 26)
    expect(findNearestScrubberIndex(25, 3, 20, 12)).toBe(0);
    expect(findNearestScrubberIndex(27, 3, 20, 12)).toBe(1);
    expect(findNearestScrubberIndex(40, 3, 20, 12)).toBe(2);
  });

  it("clamps to first bar when pointer is far above the group", () => {
    expect(findNearestScrubberIndex(-50, 5, 20, 12)).toBe(0);
  });

  it("clamps to last bar when pointer is far below the group", () => {
    expect(findNearestScrubberIndex(500, 5, 20, 12)).toBe(4);
  });
});
