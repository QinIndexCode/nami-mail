/**
 * Reading-position pinning for the message list.
 *
 * A background merge (new mail arriving, a re-sort after an action) would
 * otherwise move the row the reader is looking at. Before applying the merge the
 * list therefore remembers which row straddles the viewport's top edge, and
 * scrolls back to it afterwards.
 *
 * Rows are consumed lazily and in list order so the caller can stop measuring
 * DOM nodes as soon as the anchor is found: this runs on the scroll/refresh path
 * with hundreds of rows mounted, and each measurement can force a layout.
 */

export type ScrollAnchorRow = {
  /** Row identity, used to find the row again after the merge. */
  id: string;
  /** Viewport-relative top edge reported by getBoundingClientRect(). */
  top: number;
  height: number;
};

export type ScrollAnchor = {
  id: string;
  /** How far the viewport top sits below the row's top edge. */
  offset: number;
  /** Scroll position the anchor was captured at. */
  topCaptured: number;
};

export function resolveScrollAnchor(
  rows: Iterable<ScrollAnchorRow>,
  scrollTop: number,
  viewportTop: number,
): ScrollAnchor | null {
  // At the very top there is nothing to pin: new arrivals should simply appear.
  if (scrollTop <= 0) return null;
  for (const row of rows) {
    const contentTop = row.top - viewportTop + scrollTop;
    if (contentTop <= scrollTop && contentTop + row.height > scrollTop) {
      return { id: row.id, offset: scrollTop - contentTop, topCaptured: scrollTop };
    }
  }
  return null;
}
