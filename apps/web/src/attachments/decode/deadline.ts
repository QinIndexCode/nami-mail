import { PreviewCanceled, PreviewFailure } from "../failure";

/**
 * Runs one decode step against a wall-clock deadline and the caller's signal.
 *
 * `onTimeout` is the destructive half of a timeout (cancel a render task,
 * destroy a loading task), so it runs exactly once, *before* the rejection, and
 * its own failure is swallowed: a broken cleanup must not turn "took too long"
 * into an unhandled rejection instead of the failure the drawer can show.
 *
 * Cancellation is deliberately not a timeout — an already-aborted signal
 * rejects without arming the timer and without calling `onTimeout`, so closing
 * the drawer mid-PDF never runs the teardown path that assumes real damage.
 */
export function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new PreviewCanceled());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", handleAbort);
    };

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      release();
      settle();
    };

    const handleAbort = () => finish(() => reject(new PreviewCanceled()));

    signal?.addEventListener("abort", handleAbort, { once: true });
    timer = setTimeout(() => {
      finish(() => {
        try {
          onTimeout();
        } catch {
          // Best effort: the call below is the outcome the user sees.
        }
        reject(new PreviewFailure("timeout"));
      });
    }, milliseconds);

    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
