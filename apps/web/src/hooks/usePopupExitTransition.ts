import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Gives a popup surface (dropdown, menu, panel) an exit transition instead of
 * unmounting abruptly. Callers render while `mounted` is true and apply the
 * `closing` class to their surface (CSS drives the fade/scale-out); user
 * dismissals go through `beginClose()`, which flips `closing` on, waits out
 * the animation, then fires `onClosed` so the caller can flip `open` off.
 * A direct `open -> false` transition (parent-driven close, e.g. another
 * surface opening) clears the closing state immediately — only explicit
 * user dismissals animate. Reduced-motion users get an immediate close.
 */
export function usePopupExitTransition(open: boolean, onClosed: () => void, durationMs = 140): {
  mounted: boolean;
  closing: boolean;
  beginClose: () => void;
} {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const durationRef = useRef(durationMs);

  useEffect(() => {
    durationRef.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? 0
      : durationMs;
  }, [durationMs]);

  // A parent-driven open -> false transition cancels any pending close.
  useEffect(() => {
    if (open) return undefined;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setClosing(false);
    return undefined;
  }, [open]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const beginClose = useCallback(() => {
    if (closing || !open) return;
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      try {
        onClosed();
      } finally {
        setClosing(false);
      }
    }, durationRef.current);
  }, [closing, open, onClosed]);

  return { mounted: open || closing, closing, beginClose };
}
