import { api, type BatchJobCreatePayload, type BatchJobSnapshot } from "./api";
import { mailErrorToastMessage } from "./errorPresentation";
import type { Translate } from "./i18n";

const POLL_INTERVAL_MS = 600;
const MAX_JOB_DURATION_MS = 10 * 60_000;

export type BatchJobToastKind = "success" | "error" | "info";
export type BatchJobToastAction = { label: string; run: () => void };

export type BatchJobRunnerDeps = {
  showToast: (message: string, kind: BatchJobToastKind, action?: BatchJobToastAction) => void;
  reload: (opts: { silent: boolean }) => Promise<void> | void;
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
 * Drives a server-side batch job: create → poll until it settles → report the
 * real outcome with an undo action → reconciling reload. The toolbar stays
 * interactive throughout; only the poll loop and the final reload run in the
 * background. Guards against a vanished job (server restart) and runaway
 * polling.
 *
 * Extracted from App.tsx so the state machine has its own unit tests; App
 * wires the React-side callbacks (snapshot/busy state, toasts, reload).
 */
export function createBatchJobRunner(deps: BatchJobRunnerDeps) {
  const { showToast, t, reload, exitSelectionMode, onSnapshot, onBusy } = deps;
  const now = deps.now ?? Date.now;
  let startedAt = 0;

  /**
   * Follows an already-accepted job to its terminal state without touching the
   * UI's progress state, then reports. The undo POST only *accepts* the inverse
   * job — the reverse itself runs server-side afterwards — so reloading when
   * the POST returns would snapshot the pre-undo list and the undo would look
   * like it did nothing.
   */
  const followToSettled = (jobId: string, onSettled: () => void): void => {
    const startedFollowingAt = now();
    const next = async (): Promise<void> => {
      if (now() - startedFollowingAt > MAX_JOB_DURATION_MS) {
        onSettled();
        return;
      }
      let settled = true;
      try {
        settled = (await api.batchJobStatus(jobId)).job.status !== "running";
      } catch {
        // A status read that fails cannot confirm the inverse job; reconcile
        // from the server anyway rather than polling until the deadline.
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
    const next = async (): Promise<void> => {
      if (now() - startedAt > MAX_JOB_DURATION_MS) {
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
          onSnapshot(null);
          showToast(job.error ?? t("mail.selection.jobError"), "error");
          await reload({ silent: true });
          opts.onSettled?.();
          return;
        }
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
        opts.onSettled?.();
      } catch {
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
      startedAt = now();
      onSnapshot({ id: jobId, kind: payload.kind, status: "running", total: 0, done: 0, updated: 0, failed: 0, createdAt: Date.now() });
      // The job runs server-side; release the toolbar (progress comes from
      // the poll loop) so the list stays interactive.
      onBusy(false);
      poll(jobId, opts);
    }).catch((error: unknown) => {
      onBusy(false);
      opts.onSettled?.();
      showToast(mailErrorToastMessage(error, t(payload.kind === "flags" ? "mail.error.batchUpdate" : "mail.error.move"), t), "error");
    });
  };

  return { start, poll };
}
