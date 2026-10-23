import { serverLog } from "../logging.js";
import { acquireAccountWriteSlots, isAccountWriteSlotTimeoutError, withHeldWriteSlots, withTimeout } from "../sync-locks.js";
import {
  claimNextTask,
  claimTaskRow,
  dueAccountIds,
  openTaskPayload,
  pruneTerminalTasks,
  releaseTaskForRetry,
  reportTaskProgress,
  settleTask,
  taskItems,
  taskRow,
} from "./store.js";
import {
  TASK_ERROR_NO_RUNNER,
  type SchedulerDeps,
  type TaskHooks,
  type TaskRow,
  type TaskScheduler,
  type TaskStatus,
  type TaskTerminalStatus,
} from "./types.js";

/**
 * The durable task scheduler.
 *
 * Two claims about this file are worth stating up front, because they are what
 * the old write-behind queue got right and must not be lost:
 *
 *   1. **Serial per account, parallel across accounts.** One FIFO chain per
 *      account, and a task holds its place through a backoff wait. Order is not
 *      cosmetic here: two flag updates to the same message compose, so running
 *      them backwards leaves the server holding the older value.
 *   2. **A task's local effect is already committed.** The runner only converges
 *      the provider; it never writes the user-visible target state. That is why
 *      a failure here is a reconciliation problem, not a data-loss one.
 */

/** Longest one task may hold the account slot before it is abandoned. A hung
 * IMAP command must not stall every later task on the account forever. */
export const TASK_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** Backoff: eight attempts span roughly 90 seconds (1+2+4+8+16+30+30). */
export const TASK_RETRY_BASE_MS = 1_000;
export const TASK_RETRY_MAX_MS = 30_000;

/** How often tasks whose `due_at` has arrived are picked up. */
export const TASK_DUE_TICK_MS = 15_000;

/**
 * Thrown by a runner that has decided the task's real terminal state.
 *
 * Some outcomes are only knowable inside the runner -- a scheduled send whose
 * ledger row was already recovered as `unknown_delivery` must NOT be sent again,
 * and a message the user snoozed then cancelled should settle `cancelled`, not
 * `failed`. Returning normally would let the scheduler overwrite that verdict
 * with `completed`; a plain `Error` would send it down the retry path. So the
 * runner says what happened and the scheduler records it.
 */
export class TaskAbortError extends Error {
  readonly status: TaskTerminalStatus;
  readonly code?: string;

  constructor(status: Exclude<TaskTerminalStatus, "completed">, message: string, code?: string) {
    super(message);
    this.name = "TaskAbortError";
    this.status = status;
    this.code = code;
  }
}

/**
 * A run that outlived {@link TASK_RUN_TIMEOUT_MS}.
 *
 * Typed rather than a bare `Error` with the same wording because the catch has
 * to tell two cases apart: a runner that failed (it has already stopped) and an
 * attempt the scheduler stopped waiting for (it has not). The second is the one
 * that must abort the runner's transport and fence everything it says next, and
 * matching on the message would make that decision depend on a string.
 */
export class TaskRunTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRunTimeoutError";
  }
}

type Failure = { retryable: boolean; error: { code?: string; message: string } };

type AttemptOutcome = { kind: "settled" } | { kind: "failed"; failure: Failure };

function failureOf(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  // An error that names its own code keeps it. The mail layer's do (that is what
  // `mailErrorCode` reads), and dropping it here would record the same failure
  // under a code in the ledger and under none on the task row -- the two
  // diagnoses of one event disagreeing. Non-strings are ignored so a stray
  // `{code: 500}` cannot reach a TEXT column.
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return { retryable: true, error: { ...(typeof code === "string" && code ? { code } : {}), message } };
}

export function startTaskScheduler(deps: SchedulerDeps): TaskScheduler {
  const { db, registry, masterKey } = deps;
  const hooks: TaskHooks = deps.hooks ?? {};
  const now = deps.now ?? (() => Date.now());
  const dueTickMs = deps.dueTickMs ?? TASK_DUE_TICK_MS;
  const retryBaseMs = deps.retryBaseMs ?? TASK_RETRY_BASE_MS;
  const retryMaxMs = deps.retryMaxMs ?? TASK_RETRY_MAX_MS;

  const chains = new Map<string, Promise<void>>();
  const active = new Set<Promise<void>>();
  /** One controller per in-flight attempt. Kept so shutdown can abort them: a
   * runner that outlives the process is exactly the one that must not keep
   * writing to a provider after the process that owned it has gone. */
  const attempts = new Set<AbortController>();
  /** Accounts with a drain queued but not yet begun, so a burst of commits does
   * not append one drain per commit. Cleared when the drain STARTS, not when it
   * finishes: a commit arriving while a drain is looping still needs its own
   * pass, because the running loop may already have made its final claim. */
  const waiting = new Set<string>();
  let stopped = false;
  let resumed = false;
  let tick: ReturnType<typeof setInterval> | undefined;

  function terminalRow(row: TaskRow, status: TaskStatus, error: { code?: string; message?: string } | null, at: number): TaskRow {
    // The hooks receive the row's terminal state rather than having to read it
    // back: the legacy hook issued `SELECT status FROM operation_queue WHERE id
    // = ?` to answer exactly this question, and that read is what this layer
    // exists to stop needing.
    return { ...row, status, error_code: error?.code ?? null, error_message: error?.message ?? null, updated_at: at, completed_at: at };
  }

  function notifySettled(row: TaskRow, payload: unknown, status: TaskStatus, error: { code?: string; message?: string } | null): void {
    if (!hooks.onTaskSettled) return;
    try {
      hooks.onTaskSettled(terminalRow(row, status, error, now()), payload);
    } catch (hookError) {
      serverLog.warn({ taskId: row.id, kind: row.kind }, "Task settled hook threw", hookError);
    }
  }

  /**
   * One runner progress report. The row is re-read after the write, because the
   * claim-time row the runner was handed still carries the old counters -- a
   * listener that reported those would publish a frame that is already stale.
   */
  function notifyProgress(taskId: string): void {
    if (!hooks.onTaskProgress) return;
    const current = taskRow(db, taskId);
    if (!current) return;
    try {
      hooks.onTaskProgress(current);
    } catch (hookError) {
      serverLog.warn({ taskId, kind: current.kind }, "Task progress hook threw", hookError);
    }
  }

  /** Fires once, only for a task the scheduler gave up on -- the hook that undoes
   * what the task's acceptance promised (a move goal, a flag push marker). */
  function notifyPermanentFailure(row: TaskRow, payload: unknown, error: { code?: string; message?: string } | null): void {
    if (!hooks.onTaskPermanentFailure) return;
    try {
      hooks.onTaskPermanentFailure(terminalRow(row, "failed", error, now()), payload);
    } catch (hookError) {
      serverLog.warn({ taskId: row.id, kind: row.kind }, "Task permanent-failure hook threw", hookError);
    }
  }

  /**
   * One attempt. Returns whether the task is done, or the failure the caller
   * should retry on.
   */
  async function attemptOnce(row: TaskRow, payload: unknown): Promise<AttemptOutcome> {
    const runner = registry.get(row.kind);
    if (!runner) {
      // An unregistered kind is terminal on the first sighting, not after eight
      // backoff rounds: runners are registered when the app is built, before any
      // drain starts, so no attempt can make one appear. The legacy queue
      // retried this eight times before giving up; the outcome (a failed row
      // plus the permanent-failure hook) is the same, 90 seconds sooner.
      const error = { code: TASK_ERROR_NO_RUNNER, message: `No executor registered for task kind "${row.kind}".` };
      const at = now();
      settleTask(db, row.id, "failed", error, at);
      notifySettled(row, payload, "failed", error);
      notifyPermanentFailure(row, payload, error);
      return { kind: "settled" };
    }
    // One controller per attempt, and one flag beside it. The controller is the
    // signal the runner hands to its transport, so a timeout can close the socket
    // instead of merely abandoning the promise; the flag is what makes this
    // attempt's own callbacks inert once the scheduler has given up on it.
    //
    // Both exist because a timed-out runner keeps running. Without them the
    // abandoned attempt still reports counts into a row a later attempt owns, and
    // still writes to the provider after the account slot was released -- so a
    // newer task can land first and then be overwritten by the older one, which
    // is the inversion the FIFO chain exists to prevent. Closing the transport is
    // the part that stops new writes; the flag is the part that stops the ones
    // already decided from being *reported* as this task's outcome.
    const controller = new AbortController();
    let live = true;
    attempts.add(controller);
    let releases: Array<() => void> = [];
    try {
      // The slot is acquired and released here rather than through
      // withAccountWriteLocks, so a timed-out run still releases the account:
      // the abandoned executor keeps running, but later tasks on that account
      // stop waiting behind it. `releases` starts empty, so the finally block
      // only releases what was actually taken.
      releases = await acquireAccountWriteSlots([row.account_id]);
      const timeoutMessage = `Task "${row.kind}" timed out after ${TASK_RUN_TIMEOUT_MS / 1000}s.`;
      await withTimeout(
        withHeldWriteSlots([row.account_id], async () => {
          await runner({
            task: row,
            payload: payload as unknown,
            items: taskItems(db, row.id),
            signal: controller.signal,
            report: (delta) => {
              // An abandoned attempt's counts are not this row's: the row may
              // already be running again under a newer attempt, and the legacy
              // failure this guards against is a batch job reporting more
              // messages than it selected.
              if (!live) return;
              reportTaskProgress(db, row.id, delta, now());
              notifyProgress(row.id);
            },
          });
        }),
        TASK_RUN_TIMEOUT_MS,
        timeoutMessage,
        new TaskRunTimeoutError(timeoutMessage),
      );
      const at = now();
      settleTask(db, row.id, "completed", null, at);
      notifySettled(row, payload, "completed", null);
      return { kind: "settled" };
    } catch (error) {
      // Shutdown began while this attempt was in flight: the row is durable and
      // the next start resumes it, so nothing here is written. The abort already
      // went out from `stop()`, and touching the database now would race the
      // close the caller is about to perform.
      if (stopped) return { kind: "settled" };
      if (error instanceof TaskRunTimeoutError) {
        // Abort before anything else: this is what closes the runner's socket and
        // makes the abandoned attempt stop talking to the provider. Its own
        // rejection is already handled by `withTimeout`, so nothing waits for it.
        controller.abort();
      }
      if (error instanceof TaskAbortError) {
        const at = now();
        const recorded = { ...(error.code ? { code: error.code } : {}), message: error.message };
        settleTask(db, row.id, error.status, recorded, at);
        notifySettled(row, payload, error.status, recorded);
        // `failed` is the one terminal status that means the task's promise is
        // broken, so it is the one that asks the owner to put things back.
        if (error.status === "failed") notifyPermanentFailure(row, payload, recorded);
        return { kind: "settled" };
      }
      if (isAccountWriteSlotTimeoutError(error)) {
        // A write-slot timeout says nothing about this task: it never reached
        // the executor, because the account is already saturated. Retrying would
        // add another waiter to the queue that just rejected it -- measured on a
        // wedged account, 60 queued writes turned into 480 further attempts and
        // delayed the drain by minutes. Give up, and let the hook clear the
        // task's markers; a half-applied provider effect is sync's business.
        const at = now();
        const failure: Failure = { retryable: false, error: { message: error instanceof Error ? error.message : String(error) } };
        settleTask(db, row.id, "failed", failure.error, at);
        notifySettled(row, payload, "failed", failure.error);
        notifyPermanentFailure(row, payload, failure.error);
        return { kind: "settled" };
      }
      return { kind: "failed", failure: failureOf(error) };
    } finally {
      // After this point nothing this attempt calls back can be mistaken for the
      // row's outcome. Set before the release, so a report that arrives while the
      // slot is being handed over is already ignored.
      live = false;
      attempts.delete(controller);
      // Reverse order, as the acquisition contract requires, and on every path:
      // a slot-wait timeout releases the slot it never took (the array is empty)
      // and a timed-out run releases the one it did, so later tasks on the
      // account are not stalled behind an executor that has been abandoned.
      for (const release of releases.reverse()) release();
    }
  }

  /**
   * Runs one claimed row to a terminal state, waiting out its backoff in the
   * chain.
   *
   * The wait is the point: a task that is retrying keeps its place, because the
   * tasks behind it touch the same rows. Whether a task composes out of order
   * depends on whether it writes the same rows, not on how long it waits -- a
   * task whose `due_at` has not arrived does not write anything yet, which is
   * why it does not hold the chain (see the claim predicate).
   */
  async function driveTask(claimed: TaskRow): Promise<void> {
    let row = claimed;
    let payload: unknown;
    try {
      payload = openTaskPayload(masterKey, row);
    } catch (error) {
      // A payload that cannot be opened will not open on attempt two either.
      const failure: Failure = { retryable: false, error: { message: error instanceof Error ? error.message : String(error) } };
      settleTask(db, row.id, "failed", failure.error, now());
      notifySettled(row, undefined, "failed", failure.error);
      notifyPermanentFailure(row, undefined, failure.error);
      return;
    }
    for (;;) {
      const outcome = await attemptOnce(row, payload);
      if (outcome.kind === "settled") return;
      const { failure } = outcome;
      if (!failure.retryable || row.attempt_count >= row.max_attempts) {
        const at = now();
        settleTask(db, row.id, "failed", failure.error, at);
        notifySettled(row, payload, "failed", failure.error);
        notifyPermanentFailure(row, payload, failure.error);
        return;
      }
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (row.attempt_count - 1));
      try {
        // The failure travels with the release: a retrying task reports no
        // counts, so this is the only place the attempt's cause is written down.
        releaseTaskForRetry(db, row.id, now() + delay, now(), failure.error);
      } catch {
        // The database handle is closed (shutdown during a retry): stop here.
        // The durable row is already on disk and the next start resumes it.
        return;
      }
      // Unref'd: a backoff wait must not be the reason the process stays alive
      // during shutdown.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
      // Stopped mid-backoff: leave the row pending with its next_attempt_at set.
      // The next start (or the due tick of the next process) resumes it, and no
      // attempt is wasted on a task its owner is no longer waiting for.
      if (stopped) return;
      let reclaimed: TaskRow | null;
      try {
        reclaimed = claimTaskRow(db, row.id, now());
      } catch {
        return;
      }
      // A null here means the row is no longer claimable -- most likely another
      // process took it. Either way this chain has nothing left to drive.
      if (!reclaimed) return;
      row = reclaimed;
    }
  }

  async function drainAccount(accountId: string): Promise<void> {
    try {
      for (;;) {
        if (stopped) return;
        const row = claimNextTask(db, accountId, now());
        if (!row) return;
        await driveTask(row);
      }
    } catch (error) {
      // Never rejects: the chain entry is awaited by stop()/drain() and a
      // rejection there would be an unhandled one. A closed handle lands here.
      serverLog.warn({ accountId }, "Task chain stopped early", error);
    }
  }

  function enqueueDrain(accountId: string): void {
    if (stopped || waiting.has(accountId)) return;
    waiting.add(accountId);
    const previous = chains.get(accountId) ?? Promise.resolve();
    const next = previous.then(() => {
      waiting.delete(accountId);
      return drainAccount(accountId);
    });
    chains.set(accountId, next);
    active.add(next);
    void next.then(() => active.delete(next));
  }

  async function drain(): Promise<void> {
    // Waiting can enqueue more drains, so keep going until the set stays empty.
    while (active.size) await Promise.all([...active]);
  }

  async function resume(): Promise<number> {
    if (resumed) return 0;
    resumed = true;
    const pruned = pruneTerminalTasks(db, now());
    if (pruned) serverLog.warn({ pruned }, "Pruned expired task rows");
    // A fresh process cannot have a running task -- the status describes an
    // executor that no longer exists. Flipping them back is what makes them
    // claimable again, since the claim predicate only takes `pending` rows.
    // `attempt_count` is kept, so a task that died mid-retry does not get a
    // fresh budget of attempts.
    const flipped = db.prepare("UPDATE tasks SET status = 'pending' WHERE status = 'running'").run().changes;
    if (flipped) serverLog.warn({ flipped }, "Resumed interrupted tasks");
    for (const accountId of dueAccountIds(db, now())) enqueueDrain(accountId);
    // Rows whose backoff has not expired are picked up by the due tick instead
    // of by a timer per row.
    return (db.prepare("SELECT COUNT(*) FROM tasks WHERE status = 'pending'").pluck().get() as number) ?? 0;
  }

  tick = setInterval(() => {
    if (stopped) return;
    try {
      for (const accountId of dueAccountIds(db, now())) enqueueDrain(accountId);
    } catch (error) {
      serverLog.warn({ dueTickMs }, "Task due sweep failed", error);
    }
  }, dueTickMs);
  // Without this the interval alone would keep the process alive after the last
  // request, which no other part of the server expects.
  tick.unref?.();

  return {
    start(taskId: string): void {
      if (stopped) return;
      const row = taskRow(db, taskId);
      // A row that is not there was rolled back with its transaction, or already
      // pruned. Either way there is nothing to run.
      if (!row) return;
      enqueueDrain(row.account_id);
    },
    resume,
    /**
     * Stops dispatching and aborts whatever is still running. It does NOT wait
     * for in-flight work, and that is a deliberate difference from a naive
     * `await drain()`: a chain can be sitting out a 30s backoff inside a provider
     * call, and shutdown must not hang on it. Nothing is lost -- the rows are
     * durable, and the next start resumes them.
     *
     * Aborting is the half that costs nothing and prevents something real: a
     * runner whose socket survives the process keeps writing to the mailbox after
     * the database it reports into has been closed. The runner sees the abort at
     * its transport (a closed connection rejects the pending command), and the
     * scheduler writes nothing further for it (`attemptOnce`'s `stopped` arm).
     * Callers that need the work finished (tests) use `drain()` instead.
     */
    async stop(): Promise<void> {
      stopped = true;
      if (tick) {
        clearInterval(tick);
        tick = undefined;
      }
      for (const controller of attempts) controller.abort();
    },
    drain,
  };
}