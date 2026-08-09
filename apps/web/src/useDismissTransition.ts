import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Gives a dialog an exit transition instead of unmounting abruptly. Callers
 * apply the `closing` class to their backdrop/card (CSS drives the fade-out),
 * then `onClose` fires after the exit animation. Reduced-motion users get an
 * immediate close with no dead time.
 *
 * Dialogs nested inside a parent that survives the close (e.g. an editor or
 * confirmation inside a modal) must call `reset()` again before reopening:
 * the `closing` state otherwise lingers and the reopen renders in the closing
 * state.
 */
export function useDismissTransition(onClose: () => void, durationMs = 170): {
  closing: boolean;
  requestClose: () => void;
  reset: () => void;
} {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const durationRef = useRef(durationMs);

  useEffect(() => {
    durationRef.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? 0
      : durationMs;
  }, [durationMs]);

  const requestClose = useCallback(() => {
    setClosing((current) => {
      if (current) return current;
      timerRef.current = window.setTimeout(() => {
        onClose();
      }, durationRef.current);
      return true;
    });
  }, [onClose]);

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setClosing(false);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { closing, requestClose, reset };
}