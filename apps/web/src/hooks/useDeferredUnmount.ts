import { useCallback, useEffect, useState } from "react";
import { useDismissTransition } from "./useDismissTransition";

/**
 * Keeps freshly rendered content mounted through an exit transition instead of
 * unmounting between frames.
 *
 * While `open` holds, `snapshot` tracks `content` on every change. When `open`
 * turns false, the last snapshot stays renderable with `closing` true for the
 * dismiss-transition window, then clears; reopening during the fade cancels the
 * pending unmount and adopts the fresh content. `render` is the mount gate
 * (`open || snapshot !== null`) so callers can keep one conditional.
 */
export function useDeferredUnmount<T>(open: boolean, content: T): {
  render: boolean;
  snapshot: T | null;
  closing: boolean;
} {
  const [snapshot, setSnapshot] = useState<T | null>(null);
  const { closing, requestClose, reset } = useDismissTransition(useCallback(() => setSnapshot(null), []));
  useEffect(() => {
    if (open) {
      reset();
      setSnapshot(content);
    } else if (snapshot !== null && !closing) {
      requestClose();
    }
  }, [closing, content, open, requestClose, reset, snapshot]);
  return { render: snapshot !== null, snapshot, closing };
}
