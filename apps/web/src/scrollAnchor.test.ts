import { describe, expect, it } from "vitest";
import { resolveScrollAnchor, type ScrollAnchorRow } from "./scrollAnchor";

const VIEWPORT_TOP = 40;
const ROW_HEIGHT = 60;

/**
 * Rows described in content coordinates — `getBoundingClientRect().top` is
 * viewport-relative, so each entry is converted back the way the DOM would
 * report it at the given scroll position.
 */
function rowsAt(contentTops: number[], scrollTop: number): ScrollAnchorRow[] {
  return contentTops.map((contentTop, index) => ({
    id: `row-${index}`,
    top: VIEWPORT_TOP + contentTop - scrollTop,
    height: ROW_HEIGHT,
  }));
}

describe("resolveScrollAnchor", () => {
  it("does not pin anything at the very top of the list", () => {
    expect(resolveScrollAnchor(rowsAt([0, 100, 200], 0), 0, VIEWPORT_TOP)).toBeNull();
  });

  it("picks the row straddling the viewport top and reports the offset into it", () => {
    // Rows at content 0 / 120 / 300, scrolled to 150: row 1 covers 120..180.
    expect(resolveScrollAnchor(rowsAt([0, 120, 300], 150), 150, VIEWPORT_TOP)).toEqual({
      id: "row-1",
      offset: 30,
      topCaptured: 150,
    });
  });

  it("skips rows entirely above the viewport top", () => {
    // Rows at 0..60 / 60..120 / 200..260, scrolled to 210.
    expect(resolveScrollAnchor(rowsAt([0, 60, 200], 210), 210, VIEWPORT_TOP)).toEqual({
      id: "row-2",
      offset: 10,
      topCaptured: 210,
    });
  });

  it("returns null when a gap sits at the viewport top", () => {
    // Rows 0..60 and 300..360, scrolled to 200: nothing straddles the top edge.
    expect(resolveScrollAnchor(rowsAt([0, 300], 200), 200, VIEWPORT_TOP)).toBeNull();
  });

  it("stops measuring rows once the anchor is found", () => {
    let pulled = 0;
    function* counted(): Generator<ScrollAnchorRow> {
      for (const row of rowsAt([0, 120, 300, 400, 500, 600], 150)) {
        pulled += 1;
        yield row;
      }
    }
    expect(resolveScrollAnchor(counted(), 150, VIEWPORT_TOP)?.id).toBe("row-1");
    // The caller measures DOM nodes as the generator yields, so the rows after
    // the anchor must never be touched.
    expect(pulled).toBe(2);
  });
});
