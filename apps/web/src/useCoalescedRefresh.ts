import { useCallback, useEffect, useRef } from "react";

export type CoalescedRefreshOptions = {
  /**
   * Minimum gap (ms) between two immediate refreshes. Bursts of requests
   * arriving inside one window collapse into a single trailing refresh. Zero
   * disables coalescing entirely.
   */
  minIntervalMs?: number;
};

/**
 * Turns fire-and-forget refresh requests into one gate that all triggering
 * paths (SSE events, the desktop new-mail IPC bridge, the poll fallback and
 * the Agent's mail-state notifications) share. It exists because a mail
 * client must not do full, expensive list refreshes while no one is looking:
 *
 *  - While the document is hidden (window minimized) a request only marks the
 *    state dirty and returns — zero rendering work in the background. The
 *    pending state is flushed by a single catch-up refresh the moment the
 *    window is visible again.
 *  - While a refresh is already in flight, the request is deferred to exactly
 *    one trailing pass (no stacking — a burst of N events costs one refresh,
 *    not N).
 *  - Requests inside the coalescing window collapse onto one trailing refresh
 *    too, so a foreground event storm never floods the main thread with
 *    repeated full reloads.
 *
 * The returned function has a stable identity (it depends only on the stable
 * options), so it is safe to pass to effects/keyed subscriptions that would
 * otherwise re-run whenever the underlying refresh callback changes.
 */
export function useCoalescedRefresh(
  refresh: () => Promise<void> | void,
  { minIntervalMs = 2_000 }: CoalescedRefreshOptions = {},
): () => void {
  // The callback is reached through a ref so its own identity (which changes
  // on every render) never ripples into the gate below.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const dirtyRef = useRef(false);
  const runningRef = useRef(false);
  const lastCompletedAtRef = useRef(0);
  const trailingTimerRef = useRef<number | null>(null);

  const drain = useCallback(() => {
    const now = Date.now();
    const msSinceLast = now - lastCompletedAtRef.current;

    // A pass is already running — remember one trailing request and let the
    // running pass trigger it, so concurrent callers stack into zero extra work.
    if (runningRef.current) {
      dirtyRef.current = true;
      return;
    }
    // Too soon after the last completed refresh: remember the request and arm a
    // single trailing timer at the oldest convenient fire time instead of
    // bursting now.
    if (msSinceLast < minIntervalMs) {
      dirtyRef.current = true;
      if (trailingTimerRef.current === null) {
        const wait = Math.max(0, minIntervalMs - msSinceLast);
        trailingTimerRef.current = window.setTimeout(() => {
          trailingTimerRef.current = null;
          drain();
        }, wait);
      }
      return;
    }

    // Run now.
    dirtyRef.current = false;
    runningRef.current = true;
    Promise.resolve()
      .then(() => refreshRef.current())
      .catch(() => undefined) // refresh is expected to swallow errors; never let one stick in the gate.
      .finally(() => {
        runningRef.current = false;
        lastCompletedAtRef.current = Date.now();
        // A request that arrived while this pass was running or blocked waits
        // here; run it now as the single trailing pass.
        if (dirtyRef.current) drain();
      });
  }, [minIntervalMs]);

  const requestRefresh = useCallback(() => {
    // Hidden window: postpone the actual work until the user looks again. The
    // visibility listener below runs the catch-up so nothing is lost.
    if (document.hidden) {
      dirtyRef.current = true;
      return;
    }
    drain();
  }, [drain]);

  // Catch-up: the moment the window becomes visible again, flush exactly the
  // one pending request that accumulated while hidden.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      if (dirtyRef.current && !runningRef.current) {
        drain();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [drain]);

  // Clear any pending trailing timer on unmount.
  useEffect(() => {
    return () => {
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current);
        trailingTimerRef.current = null;
      }
    };
  }, []);

  return requestRefresh;
}