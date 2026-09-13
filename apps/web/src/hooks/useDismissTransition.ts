import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Gives a dialog an exit transition instead of unmounting abruptly. Callers
 * apply the `closing` class to their backdrop/card (CSS drives the fade-out),
 * then `onClose` fires after the exit animation and the `closing` state is
 * cleared automatically, so a permanently mounted dialog (terms prompt,
 * workspace settings) returns to a fully open state for its next use.
 * Reduced-motion users get an immediate close with no dead time.
 *
 * Dialogs nested inside a parent that survives the close (e.g. an editor or
 * confirmation inside a modal) must still call `reset()` again before
 * reopening: it cancels any pending close timer.
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
        timerRef.current = null;
        try {
          onClose();
        } finally {
          // The transition is over: drop the lingering closing state so an
          // always-mounted dialog never leaks a dead backdrop and can reopen.
          setClosing(false);
        }
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
