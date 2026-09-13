import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export type StableListStyle = Pick<CSSProperties, "height" | "overflowY" | "scrollbarGutter" | "flex"> | undefined;

/**
 * Keeps a paginated management list's viewport height stable across page
 * changes so the host dialog no longer resizes (and "flashes") when a page
 * holds fewer rows than a full page.
 *
 * While `locked` (the pagination toolbar is visible), the container height is
 * captured once from its first full-page render and then pinned. Shorter pages
 * (last page, filtered results) keep the same footprint, and rows taller than
 * the pinned viewport scroll inside it instead of growing the dialog. The lock
 * is released automatically when the list drops back below one page.
 */
export function useStablePagedListHeight<T extends HTMLElement>(
  locked: boolean,
): { ref: RefObject<T | null>; style: StableListStyle } {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!locked) {
      setHeight(null);
      return;
    }
    const element = ref.current;
    if (!element) return;
    // Capture only the first full page; later pages must not re-measure.
    setHeight((current) => current ?? element.offsetHeight);
  }, [locked]);

  return {
    ref,
    style: locked && height !== null
      // +1px absorbs sub-pixel rounding so the captured page never scrolls.
      // `flex: 0 0 auto` makes the pinned height win over any flex-basis the
      // host container applies (e.g. `flex: 1` list rows in a column layout);
      // it is inert for plain block children such as the management lists.
      ? { height: height + 1, overflowY: "auto", scrollbarGutter: "stable", flex: "0 0 auto" }
      : undefined,
  };
}
