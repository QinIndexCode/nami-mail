/**
 * Restart-delay policy for scripts/dev-server-watch.mjs. The API dev process
 * exits whenever its tsx watcher dies (a persistent compile error, a crash
 * loop), and the outer watchdog restarts it. A fixed delay hot-loops on a
 * broken tree; exponential delay with a reset after a stable run bounds the
 * churn while still restarting promptly after the first failure.
 */

export const MIN_RESTART_DELAY_MS = 2_000;
export const MAX_RESTART_DELAY_MS = 30_000;
export const STABLE_UPTIME_MS = 30_000;

/**
 * Returns the delay before the next restart.
 *
 * @param previousDelayMs delay used for the previous restart (0 on the first
 *   failure, so the first restart is always immediate-ish)
 * @param uptimeMs how long the exited process stayed up
 */
export function nextRestartDelayMs(previousDelayMs, uptimeMs) {
  if (uptimeMs >= STABLE_UPTIME_MS) return MIN_RESTART_DELAY_MS;
  if (previousDelayMs <= 0) return MIN_RESTART_DELAY_MS;
  return Math.min(previousDelayMs * 2, MAX_RESTART_DELAY_MS);
}
