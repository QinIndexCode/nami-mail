import { api, ApiError, type BatchJobCreatePayload, type BatchJobSnapshot } from "./api";
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

/**
 * Runs one of the caller's callbacks without letting it interrupt the runner's
 * own reporting. A throw from a toast or a release is the caller's problem; the
 * delivery still has to be recorded and the remaining callbacks still have to
 * run.
 */
function quietly(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Deliberately swallowed: see above.
  }
}

export type BatchJobToastKind = "success" | "error" | "info" | "warning";
export type BatchJobToastAction = { label: string; run: () => void };
/**
 * A toast that reports on the batch rather than offering an action on it.
 * `feedback` makes it replace an actionable toast instead of queueing behind
 * it: the undo the action toast offered is exactly what this result follows.
 */
export type BatchJobToastOptions = { feedback?: boolean };

/**
 * How a delivery ended, as the thing the doer of an undo needs to know.
 *
 * Three values rather than a boolean because "it failed" and "we stopped
 * watching" are different answers to give the user, and only the first one is a
 * fact about the mail server.
 */
export type DeliveryOutcome = "completed" | "failed" | "unknown";

export type BatchJobRunnerDeps = {
  showToast: (
    message: string,
    kind: BatchJobToastKind,
    action?: BatchJobToastAction,
    options?: BatchJobToastOptions,
  ) => void;
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
  onBusy: (busy: boolean) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
};

export type BatchJobRunOptions = {
  successKey: string;
  exitOnSuccess: boolean;
  /**
   * This batch's delivery ended — delivered, refused to start, or no longer
   * being watched. Its one use is releasing the pins that hold an optimistic
   * row against a refresh (see `useBatchSelection`).
   *
   * CARRIED BY THE BATCH, not by the runner: batches overlap (the toolbar
   * releases at acceptance), so a single runner-level callback would have every
   * batch consume whichever release was installed last and leave the other
   * batch's pins either armed too long or dropped too early.
   *
   * It fires exactly once per batch, on every terminal path, and always before
   * that batch's settling reload: a pin left armed through the refresh would
   * keep a refused row looking applied, which is the whole reason the release
   * is ordered this way. That includes a create the server refused and a batch
   * that committed nothing — both had optimistic state to give back.
   */
  onDeliverySettled?: () => void;
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
  const { showToast, t, reload, reconcile, exitSelectionMode, onBusy } = deps;
  // Reports about an action the user just took must not hide behind the next
  // actionable toast, so they replace it instead of queueing.
  const showFeedback = (message: string, kind: BatchJobToastKind) => {
    showToast(message, kind, undefined, { feedback: true });
  };
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
   * Follows an already-accepted job to its terminal state, then reports it.
   *
   * The undo POST only *accepts* the inverse job — the reverse itself runs
   * server-side afterwards — so reloading when the POST returns would snapshot
   * the pre-undo list and the undo would look like it did nothing. What makes the
   * undo visible is following each reverse task to its end, and `null` is the
   * answer for a follow-up that could not reach one: the job may well have
   * finished, but this caller has no snapshot to describe, and "unknown" is not
   * the same claim as "done".
   */
  const followToSettled = (jobId: string, onSettled: (job: BatchJobSnapshot | null) => void): void => {
    const startedFollowingAt = now();
    // A status read can fail transiently (a blip, a restart in progress). One
    // failed read used to end the follow-up on the spot, which is exactly the
    // "undo looks inert" symptom this loop exists to remove, so give up only
    // after a few consecutive failures — and let the deadline bound the rest.
    let consecutiveReadFailures = 0;
    const next = async (): Promise<void> => {
      if (now() - startedFollowingAt > MAX_JOB_DURATION_MS) {
        onSettled(null);
        return;
      }
      let settled: BatchJobSnapshot | null = null;
      try {
        const { job } = await api.batchJobStatus(jobId);
        consecutiveReadFailures = 0;
        if (isSettledJobStatus(job.status)) settled = job;
      } catch {
        consecutiveReadFailures += 1;
      }
      if (settled || consecutiveReadFailures >= MAX_STATUS_READ_FAILURES) {
        onSettled(settled);
        return;
      }
      setTimeout(() => void next(), POLL_INTERVAL_MS);
    };
    void next();
  };

  /**
   * Follows every id the undo committed, and reports all of them once they have
   * settled.
   *
   * A list rather than one id because the reverse is one undoable task per
   * account (contract §4.7 A ⑨): a selection spanning three accounts commits
   * three, and no single root groups them — the response is the only place the
   * caller learns them. Reporting on the first to settle would reconcile while the
   * others are still running, which is the "undo looks inert" symptom the
   * single-id follow-up was written to remove. An empty list settles immediately
   * and vacuously: the server answers no ids for a reverse with no work left to do
   * (the state is already what the undo asked for), which is a success rather than
   * a silence to report as unknown.
   */
  const followAllToSettled = (ids: readonly string[], onSettled: (jobs: readonly (BatchJobSnapshot | null)[]) => void): void => {
    if (!ids.length) {
      onSettled([]);
      return;
    }
    // Reported in the order the server named them, so a caller reading the
    // snapshots sees the same job order the undo answered with.
    const results: (BatchJobSnapshot | null)[] = ids.map(() => null);
    let remaining = ids.length;
    ids.forEach((id, index) => {
      followToSettled(id, (job) => {
        results[index] = job;
        remaining -= 1;
        if (remaining === 0) onSettled(results);
      });
    });
  };

  /** What to say when the server refused the undo, one sentence per word.
   *
   * The refusal arrives as a rejected 404/409, so the only place the reason
   * survives is `ApiError.reason` (`BatchJobUndoReason`). Collapsing the words into
   * one generic sentence — what the old code did with `mail.selection.jobError` —
   * told a user whose window had closed the same thing as one whose job the server
   * could not find. An unknown word falls back to that generic sentence: a newer
   * server is allowed to refuse for a reason this bundle predates.
   */
  const UNDO_REFUSAL_KEYS: Record<string, string> = {
    not_found: "mail.selection.undoNotFound",
    // Two server words, one user-facing fact: `unsupported_parent` is a kind whose
    // actions never offer an undo, `no_window` is an action of an undoable kind
    // that offered none (a single move). Neither can be acted on.
    unsupported_parent: "mail.selection.undoUnsupported",
    no_window: "mail.selection.undoUnsupported",
    not_completed: "mail.selection.undoUnavailable",
    already_undone: "mail.selection.undoAlreadyDone",
    expired: "mail.selection.undoExpired",
    inverse_unavailable: "mail.selection.undoInverseUnavailable",
  };

  const undoRefusalMessage = (error: unknown): string | null => {
    if (!(error instanceof ApiError) || !error.reason) return null;
    const key = UNDO_REFUSAL_KEYS[error.reason];
    return key ? t(key) : null;
  };

  /**
   * What to say once the reverse has settled.
   *
   * The POST only answered "the inverse is committed"; whether the messages are
   * actually back is decided by the reverse tasks, and by the time they finish the
   * acceptance toast is long gone. A member's `failed` counts the entries the
   * reverse could not restore, so their sum is the honest "M 封没有撤销" number.
   *
   * A settled member with `failed: 0` and a failed status is *not* that number: the
   * reverse never ran (an account it could not reach, a payload that would not
   * open), so nothing was counted and nothing can be promised — "we do not know" is
   * the answer rather than "done". The same goes for a follow-up that never reached
   * a snapshot at all.
   */
  const reportUndo = (results: readonly (BatchJobSnapshot | null)[]): void => {
    const known = results.filter((job): job is BatchJobSnapshot => job !== null);
    const unrestored = known.reduce((count, job) => count + Math.max(0, job.failed), 0);
    if (unrestored > 0) {
      showFeedback(t("mail.selection.undoPartialFailure", { count: unrestored }), "error");
      return;
    }
    if (known.length !== results.length || known.some((job) => job.status !== "completed")) {
      showFeedback(t("mail.selection.undoUnknown"), "warning");
      return;
    }
    showFeedback(t("mail.selection.undoDone"), "success");
  };

  /**
   * The undo offered by the acceptance toast.
   *
   * It waits for the delivery's outcome before it POSTs, because the server
   * refuses to undo work that has not finished (`undoRefusal` answers
   * `not_completed`) — see `deliveries` above. The wait is unconditional: a push
   * that ended `failed` or `cancelled` is undone exactly like a completed one,
   * because the local target state was committed at acceptance and the alias
   * reports a partly failed job as `completed` (so the button is offered for that
   * set on purpose). An outcome this runner stopped watching (`unknown`) is not
   * filtered out either: the POST is the only way to learn whether the task ever
   * finished, and the server's `not_completed` is a better answer than a guess.
   *
   * Once the POST is accepted the reverse is followed to its end and reported
   * (`reportUndo`); the click has no other feedback, since the acceptance toast it
   * came from is dismissed by the click itself.
   */
  const undoActionFor = (jobId: string): BatchJobToastAction => ({
    label: t("mail.selection.undo"),
    run: () => {
      showFeedback(t("mail.selection.undoStarted"), "info");
      void deliveryOutcome(jobId).then(() => {
        void api.batchJobUndo(jobId).then((result) => {
          followAllToSettled(result?.taskIds ?? [], (jobs) => {
            reportUndo(jobs);
            // `reconcile`, not `reload`: the undo restores rows the list is already
            // showing, and the full load would collapse the pagination and the
            // scroll position the user is reading them at. The reverse's own
            // settlement is the authority on what the server holds, so this read
            // only has to bring the visible page up to date.
            reconcileQuietly(reconcile);
          });
        }).catch((error: unknown) => {
          showToast(undoRefusalMessage(error) ?? t("mail.selection.jobError"), "error");
          // A refused undo is still a read worth taking: another account's member
          // may have been reversed before the refusal was met, and a background
          // write may have moved the rows the user is looking at.
          reconcileQuietly(reconcile);
        });
      });
    },
  });

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
      quietly(opts.onDeliverySettled);
      try {
        await report();
      } catch {
        // A refresh that failed is the next background refresh's problem.
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
      // Reporting must not be able to strand the delivery: a throw from a toast
      // or a selection update would otherwise skip the watch below, leaving the
      // pins armed and the batch unundoable. The counts are already committed;
      // losing one sentence of the report is the smaller failure.
      try {
        const undoAction = jobId && updated > 0 ? undoActionFor(jobId) : undefined;
        if (failed) {
          showToast(t("mail.selection.partialFailure", { done: updated, failed }), "error", undoAction);
        } else {
          showToast(t(opts.successKey, { count: updated }), "success", undoAction);
        }
        // The action is done once its local effect is committed, and this
        // acceptance was the commit.
        if (updated > 0 && opts.exitOnSuccess) exitSelectionMode();
      } catch {
        // See above.
      }
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
      quietly(opts.onDeliverySettled);
      try {
        await reload({ silent: true });
      } catch {
        // The batch is over; a refresh that failed is the next background
        // refresh's problem, not a reason to leave the toolbar armed.
      }
    }, async (error: unknown) => {
      // The refusal handler is `.then`'s SECOND argument, not a chained
      // `.catch`: a chained catch also receives whatever the accepted path
      // throws, and would then toast a batch failure over a batch the server had
      // already accepted and committed. The two are different facts — "the
      // server refused to start this" versus "reporting an accepted batch went
      // wrong" — and only the first one is something the user must be told.
      onBusy(false);
      // A refused create committed nothing the caller can see, so the pins come
      // off here rather than through the watch's usual path — and they come off
      // BEFORE the read below, or the read would keep showing the optimistic
      // value this batch is being told never landed.
      quietly(opts.onDeliverySettled);
      // The toast comes first: it is the user's only answer, and it must not
      // wait on a read that may itself be the thing that failed.
      quietly(() => showToast(
        mailErrorToastMessage(error, t(payload.kind === "flags" ? "mail.error.batchUpdate" : "mail.error.move"), t),
        "error",
      ));
      // A response lost on the way back is indistinguishable from a refusal at
      // this point, and the two leave opposite states on screen: the caller
      // applied an optimistic patch / removed moved rows before it asked. One
      // read settles which happened — it reports the commit if the request did
      // land, and the pre-batch truth if it did not.
      //
      // It has to be a full `reload`, not the pagination-preserving `reconcile`:
      // the latter reads the first page only, so a patch applied to rows on
      // later pages would keep the refused value until the next full load. The
      // page collapse is the price the push-failure path already pays for the
      // same correctness.
      try {
        await reload({ silent: true });
      } catch {
        // A refresh that failed is the next background refresh's problem.
      }
    });
  };

  return { start, followDelivery };
}
