/**
 * Keyboard navigation for the message-list context menu.
 *
 * Kept apart from the component so the wrap-around arithmetic is unit-testable
 * without a DOM: the menu is a roving-focus list (one focused item at a time)
 * and a keyboard user must be able to cycle it, jump to either end, and leave.
 */

/** Index of the item to focus, or `null` when the key is not a menu navigation key. */
export function contextMenuItemIndexForKey(key: string, currentIndex: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      // A menu opened without focus (-1) starts at the first item.
      return (Math.max(currentIndex, -1) + 1 + count) % count;
    case "ArrowUp":
      return (Math.max(currentIndex, 0) - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
