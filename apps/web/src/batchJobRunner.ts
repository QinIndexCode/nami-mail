import { api, type BatchJobCreatePayload, type BatchJobSnapshot } from "./api";
import { mailErrorToastMessage } from "./errorPresentation";
import type { Translate } from "./i18n";

const POLL_INTERVAL_MS = 600;
const MAX_JOB_DURATION_MS = 10 * 60_000;
/** Consecutive status-read failures tolerated before a follow-up gives up. */
const MAX_STATUS_READ_FAILURES = 3;
/**
 * How long a settled delivery stays addressable by an undo click. Must match the
 * server's own undo window: past it the server would answer `expired` anyway, so
 * forgetting the outcome costs the caller nothing it had.
 */
const UNDO_WINDOW_MS = 5 * 60_000;

/**
 * The statuses that end a job — an explicit whitelist, never `!== "running"`.
 *
 * The old default ("anything not running is finished") turned an unrecognised
 * status into a success toast with an undo button (contract K5). The alias maps
 * `pending`/`running` to `running` and `cancelled`/`unknown_delivery` to
 * `failed`, so three values reach this file today; the last two are listed
 * anyway because they are the server's vocabulary and a future alias that
 * forwards them must settle rather than poll to the ten-minute deadline.
 */
const SETTLED_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "unknown_delivery",
]);

function isSettledJobStatus(status: string): boolean {
  return SETTLED_JOB_STATUSES.has(status);
}

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

/**
 * How a delivery ended, as the thing the doer of an undo needs to know.
 *
 * Three values rather than a boolean because "it failed" and "we stopped
 * watching" are different answers to give the user, and only the first one is a
 * fact about the mail server.
 */
export type DeliveryOutcome = "completed" | "failed" | "unknown";

export type BatchJobRunnerDeps = {
  showToast: (message: string, kind: BatchJobToastKind, action?: BatchJobToastAction) => void;
  reload: (opts: { silent: boolean }) => Promise<void> | void;
  /**
   * Pulls the server's *already committed* local state into the UI the moment a
   * job is accepted, instead of at settlement — for the jobs whose acceptance
   * commits anything.
   *
   * A flags job's acceptance transaction carries the fixed selection, the
   * metadata, the folder counters and the durable push rows, so by the time
   * `batchJobCreate` resolves the local state is final; only the remote IMAP
   * push is outstanding, and on a large selection it can take tens of seconds.
   * Without this call the UI keeps describing the pre-commit state for that whole
   * window, the counters most visibly: a predicate selection optimistically
   * touches only the loaded rows (the renderer never holds all of them), so the
   * unread total and the folder badges stay wrong until the next refresh.
   *
   * A move job commits just as much at acceptance, and in the same transaction:
   * the selection AND each message's destination goal. The goal is what a
   * message's folder membership is read from, so by the time the create resolves
   * the rows are already out of the source view the renderer is showing — which
   * is what makes a "delete all matching" leave the list immediately instead of
   * when IMAP confirms. Only the destination side of the counters fills in as
   * the chunks are delivered (a message is counted in the folder it arrived in,
   * not in the one it was promised to), so this reconcile is genuinely a
   * reconcile of the move, not just a read of what was already true.
   *
   * MUST be a refresh that leaves the list as it is — App wires its
   * pagination-preserving silent refresh here. The full `reload` collapses the
   * loaded pages back to the first one and clears the predicate selection the
   * toolbar is describing; settlement is where that reset belongs.
   */
  reconcile: () => Promise<void> | void;
  exitSelectionMode: () => void;
  t: Translate;
  /**
   * The delivery of an *accepted* batch reached a terminal state: delivered,
   * refused, or no longer being watched. Named for what it reports rather than
   * for a piece of UI state, because its one use is releasing the pins that hold
   * an optimistic row against a refresh (see `useBatchSelection`).
   *
   * It fires exactly once per accepted batch, and always before that batch's
   * settling reload: a pin left armed through the refresh would keep a refused
   * row looking applied, which is the whole reason the release is ordered this
   * way. A batch the server refused never gets here — there is no delivery.
   */
  onDeliverySettled: () => void;
  onBusy: (busy: boolean) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
};

export type BatchJobRunOptions = {
  successKey: string;
  exitOnSuccess: boolean;
  /** Runs after the batch's delivery is over and its reconciling reload has
   * landed — pins must be cleared only here, or a refresh racing the job would
   * still clobber. */
  onSettled?: () => void;
};

/** A per-job delivery outcome, so an undo click can wait for one. */
type Delivery = {
  /** Resolves once, with how the delivery ended. */
  promise: Promise<DeliveryOutcome>;
  settle: (outcome: DeliveryOutcome) => void;
  /** When `settle` first ran; `null` while the delivery is in flight. */
  settledAt: number | null;
};

/**
 * Drives the two halves a batch is now split into.
 *
 * **The local half is reported the moment the server accepts.** Under the
 * commit-first rule (contract §二十六) `POST /api/batch-jobs` returns only after
 * its acceptance transaction has committed the local target state and recorded
 * the durable task, so the create's own counts are the real outcome of
 * everything the user can see: the toast, the undo it offers, whether to leave
 * selection mode, and the reconcile that makes the counters agree. Nothing waits
 * for the mail server, and the toolbar is released as soon as the create returns
 * — tens of seconds earlier than it used to be on a large selection.
 *
 * **The app: the remote half runs on in the background.** What is left is the
 * provider push, whose only user-visible outcomes are a refusal (toasted, with
 * the local commit explicitly left standing) and the pin release that lets a
 * reconciling refresh show what the server actually holds.
 *
 * Extracted from App.tsx so the state machine has its own unit tests; App wires
 * the React-side callbacks (busy state, toasts, reload).
 */
export function createBatchJobRunner(deps: BatchJobRunnerDeps) {
  const { showToast, t, reload, reconcile, exitSelectionMode, onDeliverySettled, onBusy } = deps;
  const now = deps.now ?? Date.now;
  /** Per-batch polling deadlines, keyed by job id. */
  const runDeadlines = new Map<string, number>();
  /**
   * One entry per accepted job, so the acceptance toast's undo can wait for its
   * delivery to end before it POSTs.
   *
   * The wait is the point. `undoRefusal` answers `not_completed` for a task that
   * has not finished, and under the commit-first rule the toast is on screen
   * while the push is usually still running, so a POST sent from the click would
   * be refused for a batch the user just watched succeed. Waiting is invisible
   * in the common case — a small selection has settled long before a human
   * reaches the button — and costs nothing in the slow one: the server's undo
   * window opens when the work finishes, not when it was committed, so a later
   * click is not a later deadline.
   *
   * The entry is created at acceptance, not at settlement, so a click can never
   * race the delivery: by then it is either pending (and the click waits) or
   * already resolved (and the click runs at once).
   */
  const deliveries = new Map<string, Delivery>();

  const trackDelivery = (jobId: string): Delivery => {
    const existing = deliveries.get(jobId);
    if (existing) return existing;
    let resolve!: (outcome: DeliveryOutcome) => void;
    const promise = new Promise<DeliveryOutcome>((settle) => {
      resolve = settle;
    });
    const delivery: Delivery = {
      promise,
      settle: (outcome) => {
        if (delivery.settledAt !== null) return;
        delivery.settledAt = now();
        resolve(outcome);
      },
      settledAt: null,
    };
    deliveries.set(jobId, delivery);
    return delivery;
  };

  /**
   * Drops the outcomes whose undo window has closed. Called at acceptance, which
   * is the only moment the map can grow: a session of a thousand batches would
   * otherwise hold a thousand entries nothing can ever read again.
   */
  const sweepDeliveries = (): void => {
    for (const [jobId, delivery] of deliveries) {
      if (delivery.settledAt !== null && now() - delivery.settledAt > UNDO_WINDOW_MS) {
        deliveries.delete(jobId);
      }
    }
  };

  /** An untracked job answers `unknown`, which is the same answer an expired
   * window gets from the server. */
  const deliveryOutcome = (jobId: string): Promise<DeliveryOutcome> =>
    deliveries.get(jobId)?.promise ?? Promise.resolve<DeliveryOutcome>("unknown");

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
        settled = isSettledJobStatus((await api.batchJobStatus(jobId)).job.status);
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

  /**
   * Follows every id the undo committed, and reports once all of them have
   * settled.
   *
   * A list rather than one id because the reverse is one undoable task per
   * account (contract §4.7 A ⑨): a selection spanning three accounts commits
   * three, and no single root groups them — the response is the only place the
   * caller learns them. Reporting on the first to settle would reload while the
   * others are still running, which is the "undo looks inert" symptom the
   * single-id follow-up was written to remove. An empty list settles
   * immediately, so a refused undo (`reason`) reconciles now instead of never.
   */
  const followAllToSettled = (ids: readonly string[], onSettled: () => void): void => {
    if (!ids.length) {
      onSettled();
      return;
    }
    let remaining = ids.length;
    for (const id of ids) {
      followToSettled(id, () => {
        remaining -= 1;
        if (remaining === 0) onSettled();
      });
    }
  };

  /**
   * What to say when the push was refused.
   *
   * The local commit stands either way, so the sentence has to name the half
   * that broke — the old text ("the batch failed") described a batch whose
   * effect the user can still see. The server's own refusal text is appended
   * when there is one, because it is the only diagnosis of the cause (a rejected
   * login, a server that never confirmed the change); a large selection reaches
   * this branch tens of seconds after its toast said the change had landed.
   */
  const deliveryFailureMessage = (job: BatchJobSnapshot): string => {
    const summary = t("mail.selection.deliveryFailed", { count: job.total });
    // The server's refusal text is the only diagnosis of the cause (a rejected
    // login, a server that never confirmed the change); the sentence in front of
    // it is what says which half of the batch the refusal belongs to.
    return job.error ? `${summary} ${job.error}` : summary;
  };

  /**
   * The undo offered by the acceptance toast.
   *
   * It waits for the delivery's outcome before it POSTs, because the server
   * refuses to undo work that has not finished (`undoRefusal`) — see
   * `deliveries` above. A delivery that failed gets a refusal of its own kind
   * (`mail.selection.undoUnavailable`), which is the same answer the old code
   * gave by not offering the button at all; the difference is that the offer
   * cannot be withdrawn once it is on screen, so the click has to explain
   * itself.
   */
  const undoActionFor = (jobId: string): BatchJobToastAction => ({
    label: t("mail.selection.undo"),
    run: () => {
      showToast(t("mail.selection.undoStarted"), "info");
      void deliveryOutcome(jobId).then((outcome) => {
        if (outcome !== "completed") {
          showToast(t("mail.selection.undoUnavailable"), "error");
          return;
        }
        void api.batchJobUndo(jobId).then((result) => {
          // An empty list means the server either refused the undo or answered
          // without ids; `followAllToSettled` reconciles now for exactly that
          // case.
          followAllToSettled(result?.taskIds ?? [], () => void reload({ silent: true }));
        }).catch(() => {
          showToast(t("mail.selection.jobError"), "error");
        });
      });
    },
  });

  /**
   * Watches an accepted batch's delivery until it ends, then reports the remote
   * half. Exported for tests, which drive it without a create round trip.
   *
   * A status read that fails is a blip, not an outcome: this loop can run for
   * minutes over a connection that hiccups, and one failed read used to end the
   * watch with "the sync outcome is unknown" while the sync was in fact fine.
   * Only a few consecutive failures, or the ten-minute budget, end it — and the
   * only thing that ends it early for real is the server's terminal status.
   */
  const followDelivery = (jobId: string, opts: BatchJobRunOptions): void => {
    // Deadlines are keyed by job: the runner serves overlapping batches, and a
    // single deadline on the runner would be reset by every newer batch, letting
    // an earlier one poll past its budget.
    if (!runDeadlines.has(jobId)) runDeadlines.set(jobId, now());
    const runStartedAt = runDeadlines.get(jobId)!;
    const delivery = trackDelivery(jobId);
    let consecutiveReadFailures = 0;
    /** Guards the ending: every path below settles the delivery exactly once. */
    let ended = false;

    /**
     * Ends the watch: records the outcome for a waiting undo click, releases the
     * pins, reports, releases what the caller held. The order matters and is the
     * same on every path — the release precedes the refreshes so a refused row
     * can come back.
     */
    const finish = async (outcome: DeliveryOutcome, report: () => Promise<void> | void): Promise<void> => {
      if (ended) return;
      ended = true;
      runDeadlines.delete(jobId);
      delivery.settle(outcome);
      // The three callbacks are the UI's, and none of them may stop the others:
      // a throw from a toast or a refresh has to leave the buttons available and
      // the delivery recorded, whatever the next background refresh does with it.
      try {
        onDeliverySettled();
      } catch {
        // The caller's own callback; the delivery is already recorded.
      }
      try {
        await report();
      } catch {
        // A refresh that failed is the next background refresh's problem.
      }
      try {
        opts.onSettled?.();
      } catch {
        // Same.
      }
    };

    /** Reading the job failed too many times in a row, or took too long: the
     * delivery is still running as far as anyone knows. */
    const stopWatching = (): Promise<void> =>
      finish("unknown", () => showToast(t("mail.selection.deliveryUnknown"), "error"));

    /** Reads the delivery's status, or null when the read itself failed. */
    const readStatus = async (): Promise<BatchJobSnapshot | null> => {
      try {
        const { job } = await api.batchJobStatus(jobId);
        consecutiveReadFailures = 0;
        return job;
      } catch {
        consecutiveReadFailures += 1;
        return null;
      }
    };

    const next = async (): Promise<void> => {
      if (now() - runStartedAt > MAX_JOB_DURATION_MS) {
        await stopWatching();
        return;
      }
      const job = await readStatus();
      if (!job) {
        if (consecutiveReadFailures >= MAX_STATUS_READ_FAILURES) {
          await stopWatching();
          return;
        }
        setTimeout(() => void next(), POLL_INTERVAL_MS);
        return;
      }
      if (!isSettledJobStatus(job.status)) {
        setTimeout(() => void next(), POLL_INTERVAL_MS);
        return;
      }
      if (job.status === "completed") {
        // Nothing to say: the local commit was the toast the user already saw,
        // and the refresh below is what makes the destination side of a move's
        // counters agree with the server.
        await finish("completed", () => reload({ silent: true }));
        return;
      }
      await finish("failed", async () => {
        showToast(deliveryFailureMessage(job), "error");
        await reload({ silent: true });
      });
    };
    void next();
  };

  const start = (payload: BatchJobCreatePayload, opts: BatchJobRunOptions): void => {
    onBusy(true);
    void api.batchJobCreate(payload).then(async ({ jobId, updated, failed }) => {
      // The commit landed with the acceptance, so this is where the batch is
      // reported. `updated + failed` is the selection size and `updated` is how
      // much of it the acceptance wrote, which is exactly what the old code read
      // off the settled job's `total`/`updated`/`failed` — one round trip and one
      // remote push earlier.
      onBusy(false);
      sweepDeliveries();
      const undoAction = jobId && updated > 0 ? undoActionFor(jobId) : undefined;
      if (failed) {
        showToast(t("mail.selection.partialFailure", { done: updated, failed }), "error", undoAction);
      } else {
        showToast(t(opts.successKey, { count: updated }), "success", undoAction);
      }
      // The action is done once its local effect is committed, and this
      // acceptance was the commit.
      if (updated > 0 && opts.exitOnSuccess) exitSelectionMode();
      if (jobId) {
        // The commit landed with the acceptance, so the state on screen can be
        // brought up to date now rather than when the remote push finishes.
        reconcileQuietly(reconcile);
        // `followDelivery` stamps the deadline and opens the delivery tracker,
        // so the watch's budget and the undo click's wait both start here.
        followDelivery(jobId, opts);
        return;
      }
      // A null id is not a failure: the acceptance committed nothing to deliver,
      // so there is no job to watch (the id would 404 forever) and nothing to
      // undo — the selection was already in the requested state, or matched no
      // message. The route sends its own counts for exactly this case. There is
      // still a batch to settle, though, and the pins come off BEFORE the
      // refresh: these rows were refused, so the refresh is what puts them back.
      onDeliverySettled();
      try {
        await reload({ silent: true });
      } catch {
        // The batch is over; a refresh that failed is the next background
        // refresh's problem, not a reason to leave the toolbar armed.
      }
      opts.onSettled?.();
    }, (error: unknown) => {
      // The refusal handler is `.then`'s SECOND argument, not a chained
      // `.catch`: a chained catch also receives whatever the accepted path
      // throws, and would then toast a batch failure over a batch the server had
      // already accepted and committed. The two are different facts — "the
      // server refused to start this" versus "reporting an accepted batch went
      // wrong" — and only the first one is something the user must be told.
      onBusy(false);
      // A refused create committed nothing and started no delivery, so the
      // release happens here and not through `onDeliverySettled`'s usual path. A
      // response lost on the way back is indistinguishable from a refusal here
      // and is deliberately not reconciled either: the next background refresh
      // is what corrects a commit whose acknowledgement never arrived.
      onDeliverySettled();
      opts.onSettled?.();
      showToast(mailErrorToastMessage(error, t(payload.kind === "flags" ? "mail.error.batchUpdate" : "mail.error.move"), t), "error");
    });
  };

  return { start, followDelivery };
}
