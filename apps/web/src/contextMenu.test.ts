import { describe, expect, it } from "vitest";
import { contextMenuItemIndexForKey } from "./contextMenu";

describe("contextMenuItemIndexForKey", () => {
  it("cycles forward and wraps at the end", () => {
    expect(contextMenuItemIndexForKey("ArrowDown", 0, 5)).toBe(1);
    expect(contextMenuItemIndexForKey("ArrowDown", 4, 5)).toBe(0);
  });

  it("cycles backward and wraps at the start", () => {
    expect(contextMenuItemIndexForKey("ArrowUp", 3, 5)).toBe(2);
    expect(contextMenuItemIndexForKey("ArrowUp", 0, 5)).toBe(4);
  });

  it("enters the menu at either end when nothing is focused yet", () => {
    expect(contextMenuItemIndexForKey("ArrowDown", -1, 5)).toBe(0);
    expect(contextMenuItemIndexForKey("ArrowUp", -1, 5)).toBe(4);
  });

  it("jumps to the first and last item", () => {
    expect(contextMenuItemIndexForKey("Home", 3, 5)).toBe(0);
    expect(contextMenuItemIndexForKey("End", 0, 5)).toBe(4);
  });

  it("ignores keys that are not menu navigation and empty menus", () => {
    expect(contextMenuItemIndexForKey("a", 1, 5)).toBeNull();
    expect(contextMenuItemIndexForKey("Escape", 1, 5)).toBeNull();
    expect(contextMenuItemIndexForKey("Tab", 1, 5)).toBeNull();
    expect(contextMenuItemIndexForKey("ArrowDown", 0, 0)).toBeNull();
  });
});
