import { api, type BatchJobCreatePayload, type BatchJobSnapshot } from "./api";
import { mailErrorToastMessage } from "./errorPresentation";
import type { Translate } from "./i18n";

const POLL_INTERVAL_MS = 600;
const MAX_JOB_DURATION_MS = 10 * 60_000;
/** Consecutive status-read failures tolerated before a follow-up gives up. */
const MAX_STATUS_READ_FAILURES = 3;

/**
 * Best-effort reconcile: a refresh that fails (or throws synchronously) has
 * nothing to add, and must never reach the job's own state machine — the
 * settlement reload remains the authority on what the server holds.
 */
function reconcileQuietly(reconcile: () => Promise<void> | void): void {
  try {
    void Promise.resolve(reconcile()).catch(() => undefined);
  } catch {
    // A synchronous throw is the same non-event as a rejected promise here.
  }
}

export type BatchJobToastKind = "success" | "error" | "info";
export type BatchJobToastAction = { label: string; run: () => void };

export type BatchJobRunnerDeps = {
  showToast: (message: string, kind: BatchJobToastKind, action?: BatchJobToastAction) => void;
  reload: (opts: { silent: boolean }) => Promise<void> | void;
  /**
   * Pulls the server's *already committed* local state into the UI the moment a
   * job is accepted, instead of at settlement.
   *
   * A job's acceptance transaction carries the fixed selection, the metadata,
   * the folder counters and the durable push rows, so by the time
   * `batchJobCreate` resolves the local state is final — only the remote IMAP
   * push is outstanding, and on a large selection it can take tens of seconds.
   * Without this call the UI keeps describing the pre-commit state for that
   * whole window, the counters most visibly: a predicate selection optimistically
   * touches only the loaded rows (the renderer never holds all of them), so the
   * unread total and folder badges stay wrong until the poll happens to see the
   * job settle.
   *
   * MUST be a refresh that leaves the list as it is — App wires its
   * pagination-preserving silent refresh here. The full `reload` collapses the
   * loaded pages back to the first one and clears the predicate selection the
   * toolbar is describing, neither of which belongs over a job that is still
   * running; settlement is where that reset belongs.
   */
  reconcile: () => Promise<void> | void;
  exitSelectionMode: () => void;
  t: Translate;
  onSnapshot: (job: BatchJobSnapshot | null) => void;
  onBusy: (busy: boolean) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
};

export type BatchJobRunOptions = {
  successKey: string;
  exitOnSuccess: boolean;
  /** Runs after the job's reconciling reload has landed — pins must be
   * cleared only here, or a refresh racing the job would still clobber. */
  onSettled?: () => void;
};

/**
 * Drives a server-side batch job: create → reconcile the committed local state
 * → poll until it settles → report the real outcome with an undo action →
 * reconciling reload. The toolbar stays interactive throughout; only the
 * reconcile, the poll loop and the final reload run in the background. Guards
 * against a vanished job (server restart) and runaway polling.
 *
 * Extracted from App.tsx so the state machine has its own unit tests; App
 * wires the React-side callbacks (snapshot/busy state, toasts, reload).
 */
export function createBatchJobRunner(deps: BatchJobRunnerDeps) {
  const { showToast, t, reload, reconcile, exitSelectionMode, onSnapshot, onBusy } = deps;
  const now = deps.now ?? Date.now;
  /** Per-batch polling deadlines, keyed by job id. */
  const runDeadlines = new Map<string, number>();

  /**
   * Follows an already-accepted job to its terminal state without touching the
   * UI's progress state, then reports. The undo POST only *accepts* the inverse
   * job — the reverse itself runs server-side afterwards — so reloading when
   * the POST returns would snapshot the pre-undo list and the undo would look
   * like it did nothing.
   */
  const followToSettled = (jobId: string, onSettled: () => void): void => {
    const startedFollowingAt = now();
    // A status read can fail transiently (a blip, a restart in progress). One
    // failed read used to end the follow-up on the spot, which is exactly the
    // "undo looks inert" symptom this loop exists to remove, so give up only
    // after a few consecutive failures — and let the deadline bound the rest.
    let consecutiveReadFailures = 0;
    const next = async (): Promise<void> => {
      if (now() - startedFollowingAt > MAX_JOB_DURATION_MS) {
        onSettled();
        return;
      }
      let settled = false;
      try {
        settled = (await api.batchJobStatus(jobId)).job.status !== "running";
        consecutiveReadFailures = 0;
      } catch {
        consecutiveReadFailures += 1;
        settled = consecutiveReadFailures >= MAX_STATUS_READ_FAILURES;
      }
      if (settled) {
        onSettled();
        return;
      }
      setTimeout(() => void next(), POLL_INTERVAL_MS);
    };
    void next();
  };

  const poll = (jobId: string, opts: BatchJobRunOptions): void => {
    // Deadlines are keyed by job: the runner serves overlapping batches, and a
    // single deadline on the runner would be reset by every newer batch, letting
    // an earlier one poll past its budget.
    if (!runDeadlines.has(jobId)) runDeadlines.set(jobId, now());
    const runStartedAt = runDeadlines.get(jobId)!;
    const next = async (): Promise<void> => {
      if (now() - runStartedAt > MAX_JOB_DURATION_MS) {
        runDeadlines.delete(jobId);
        onSnapshot(null);
        showToast(t("mail.selection.jobError"), "error");
        opts.onSettled?.();
        return;
      }
      try {
        const { job } = await api.batchJobStatus(jobId);
        if (job.status === "running") {
          onSnapshot(job);
          setTimeout(() => void next(), POLL_INTERVAL_MS);
          return;
        }
        if (job.status === "failed") {
          runDeadlines.delete(jobId);
          onSnapshot(null);
          showToast(job.error ?? t("mail.selection.jobError"), "error");
          await reload({ silent: true });
          opts.onSettled?.();
          return;
        }
        runDeadlines.delete(jobId);
        onSnapshot(null);
        // Undo is jobId-only: the server holds the changed ids of the job it
        // recorded, so the toast action must not grow a dependency on the
        // progress payload (which is progress numbers only — see
        // BatchJobSnapshot).
        const undoAction: BatchJobToastAction = {
          label: t("mail.selection.undo"),
          run: () => {
            showToast(t("mail.selection.undoStarted"), "info");
            void api.batchJobUndo(jobId).then((result) => {
              const undoJobId = result?.jobId;
              // No job id means the server either refused the undo or answered
              // without one; there is nothing to follow, so reconcile now.
              if (!undoJobId) {
                void reload({ silent: true });
                return;
              }
              followToSettled(undoJobId, () => void reload({ silent: true }));
            }).catch(() => {
              showToast(t("mail.selection.jobError"), "error");
            });
          },
        };
        if (job.updated > 0 && opts.exitOnSuccess) exitSelectionMode();
        if (job.failed) {
          showToast(
            t("mail.selection.partialFailure", { done: job.updated, failed: job.failed }),
            "error",
            job.updated > 0 ? undoAction : undefined,
          );
        } else {
          showToast(t(opts.successKey, { count: job.total }), "success", job.total > 0 ? undoAction : undefined);
        }
        await reload({ silent: true });
        runDeadlines.delete(jobId);
        opts.onSettled?.();
      } catch {
        runDeadlines.delete(jobId);
        onSnapshot(null);
        showToast(t("mail.selection.jobError"), "error");
        opts.onSettled?.();
      }
    };
    void next();
  };

  const start = (payload: BatchJobCreatePayload, opts: BatchJobRunOptions): void => {
    onBusy(true);
    void api.batchJobCreate(payload).then(({ jobId }) => {
      onSnapshot({ id: jobId, kind: payload.kind, status: "running", total: 0, done: 0, updated: 0, failed: 0, createdAt: Date.now() });
      // The job runs server-side; release the toolbar (progress comes from
      // the poll loop) so the list stays interactive.
      onBusy(false);
      // The commit landed with the acceptance, so the state on screen can be
      // brought up to date now rather than when the remote push finishes.
      reconcileQuietly(reconcile);
      runDeadlines.set(jobId, now());
      poll(jobId, opts);
    }).catch((error: unknown) => {
      onBusy(false);
      opts.onSettled?.();
      showToast(mailErrorToastMessage(error, t(payload.kind === "flags" ? "mail.error.batchUpdate" : "mail.error.move"), t), "error");
    });
  };

  return { start, poll };
}
