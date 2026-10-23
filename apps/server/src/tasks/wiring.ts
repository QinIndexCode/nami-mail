import type { AgentMailEventSink } from "../agent/mail-state-events.js";
import type { DatabaseHandle } from "../db.js";
import { emitTaskProgress, emitTaskSettled, type ServerEventBus } from "../events.js";
import type { AccountAccessTokenProvider } from "../mail.js";
import { retractPendingSentRow } from "../pending-sent.js";
import { createFlagsRunner } from "./kinds/flags.js";
import { createMoveRunner, pendingMoveItemIds, revertMoveFailures } from "./kinds/move.js";
import { createSendRunner } from "./kinds/send.js";
import { createSnoozeRunner, type SnoozeRunnerDeps } from "./kinds/snooze.js";
import { createUndoRunner, failPendingUndoItems } from "./kinds/undo.js";
import { createTaskRegistry } from "./registry.js";
import { startTaskScheduler } from "./scheduler.js";
import { clearConfirmedFlagsMarkers, frozenFlagsMessageIds, revertRefusedFlagsTargets } from "./settlement.js";
import { reportTaskProgress, taskRow } from "./store.js";
import type { TaskHooks, TaskRegistry, TaskRow, TaskScheduler, TaskStarter } from "./types.js";

/**
 * The app's wiring: which runners exist, what a task's terminal status obliges,
 * and the scheduler that drives them.
 *
 * Three exports, one job each, so each half is reachable without the others:
 * `createTaskHooks` (the settlement obligations), `registerTaskRunners` (the
 * registry), `createTaskExecution` (the composition, which is what a caller
 * wants). The tests use all three; production uses only the third.
 *
 * The mount lives in `buildApp`, and as of the legacy queue's removal it is the
 * only executor that process has. The order that got it there is worth keeping:
 * it was mounted *alongside* the queue first, and that coexistence was safe for
 * exactly one reason -- the migration, which is what would give a legacy row a
 * second executor, was still written-but-not-called, so `resume()` found no rows
 * in a database this build did not write. The legacy side has since been deleted
 * (its four executors, its handle rebuild and its boot resume, which only made
 * sense as a set), so what remains is the shape below: the switched write paths
 * commit `tasks` rows of their own, and the scheduler is their only executor.
 * The migration is mounted now -- `openDatabase` runs it on every open (4b) --
 * and it carries the obligation the coexistence used to discharge: it is the only
 * thing that will ever pick up a database an older build wrote (contract §4.7 D,
 * §0.4 十七 (12), §十九).
 *
 * What the hooks are, in the legacy's terms -- the legacy being the deleted
 * `onOperationSettled` in `app.ts`, kept here as a mapping because its two
 * segments are what these two hooks were derived from and the reasons they were
 * split still hold: `onTaskSettled` is its flags segment plus the send half that
 * has no legacy ancestor (the optimistic Sent row is new), and
 * `onTaskPermanentFailure` is its `batch-move` segment. The two legacy segments
 * each re-read the settling row's status with `SELECT status FROM
 * operation_queue WHERE id = ?`; the terminal status is now on the row the hook
 * is handed (`types.ts:246-255`), so neither half reads it back -- the counts,
 * which the run itself writes, are the exception and are re-read (see below).
 *
 * Why the move half lives on the *other* hook: its condition *is* "the scheduler
 * gave up", and saying so by which hook fires keeps the condition out of a status
 * string. `onTaskSettled` fires for every real settlement and
 * `onTaskPermanentFailure` additionally only on a give-up (`scheduler.ts:176-201`,
 * `:240-245`), so the halves stay kind-disjoint (`flags`/`send` vs `move`) and
 * none of them can run twice for one task.
 */

/**
 * `total - updated - failed`, floored at zero.
 *
 * The same rule the send runner counts by (`kinds/send.ts`): what a terminal row
 * still owes is the difference between its own two numbers, so it closes the
 * books by the row's own arithmetic rather than by this hook's idea of how many
 * entries the payload had. That matters for a migrated row, whose `total` was
 * written by the migration from a legacy job's selection size and need not equal
 * the payload's entry count.
 */
function unreportedUnits(task: { total: number; updated: number; failed: number }): number {
  return Math.max(0, task.total - task.updated - task.failed);
}

/**
 * Retires the optimistic Sent row of a send that never left, and closes its books
 * -- one call, one transaction.
 *
 * `failed` and `cancelled` both remove the row, and `completed` keeps it. That
 * split is not a preference: the row is a *claim* that the mail is in Sent because
 * the user was told it went out (`pending-sent.ts`), and `completed` is the only
 * status under which the SMTP acknowledgement was received -- the same argument
 * the flags half makes for its rollback. A `cancelled` send is not an exception:
 * its claim is just as false as a `failed` one's, and leaving the row would show a
 * mail in Sent that no provider holds. Retracting through
 * `pending-send.ts`'s own remover keeps the settle hook the row's only writer.
 *
 * The count is the same remainder the flags half reports, and it is read from the
 * row rather than taken from `task`, which is the *claim-time* snapshot: the run
 * writes `updated`/`failed` as it goes, and `reportTaskProgress` adds to whatever
 * is stored, so a stale `updated` here would land in the ledger for good. This is
 * the path that closes the books for the failures the runner never sees -- the
 * attempt budget running out, the run timeout, an unregistered kind -- which is
 * why the report is here rather than in the permanent-failure hook.
 *
 * Both writes share a transaction because they are one fact: the row's lifetime is
 * the task's, so half a settlement would leave a Sent row whose task is gone.
 */
function retirePendingSentRow(db: DatabaseHandle, task: TaskRow, at: number): void {
  const submissionId = task.submission_id;
  const owed = unreportedUnits(taskRow(db, task.id) ?? task);
  db.transaction(() => {
    // Independently conditional, because they answer to different owners: the
    // retraction needs the ledger id (null only after the ledger row was deleted,
    // which the FK allows), the report needs nothing but the task.
    if (submissionId) retractPendingSentRow(db, submissionId);
    if (owed) reportTaskProgress(db, task.id, { failed: owed }, at);
  })();
}

export type TaskHookDeps = {
  db: DatabaseHandle;
  /** Injectable so a test can pin what the remainder report is written with. */
  now?: () => number;
  /**
   * The push transport. Optional because the hooks are also constructed directly
   * by tests and by embedders with no SSE endpoint; an absent bus makes both
   * emissions no-ops rather than changing what the hooks owe the task.
   */
  serverEvents?: ServerEventBus;
};

/**
 * The settlement obligations, as the two hooks the scheduler calls.
 *
 * Send, on every real settlement: retire the optimistic Sent row unless the mail
 * actually left (`retirePendingSentRow`). The condition is `status !== "completed"`
 * rather than `status === "failed"` for the same reason the flags half spells it
 * that way: `unknown_delivery` and `cancelled` reach this hook through
 * `TaskAbortError` and never reach the permanent-failure hook, which fires only on
 * `error.status === "failed"` (`scheduler.ts:186`). Keying on `failed` would leave
 * a placeholder behind for exactly the two cases where the mail is least likely to
 * exist.
 *
 * Flags, on every real settlement: give back what a refused push never
 * delivered, then clear the markers. The order is load-bearing and is the
 * legacy's (`app.ts:305-307` against the pre-batch-4 revision; that hook is
 * deleted): the rollback's own `WHERE pending_flags_push = 1`
 * finds nothing once the markers are gone. The condition is
 * `status !== "completed"` rather than `status === "failed"` -- `completed` is
 * the only terminal status under which every STORE was acknowledged
 * (`pushFlagsRemote` throws on an unconfirmed one), and `cancelled` means a
 * refused target would be read as the server's state for good, exactly like
 * `failed` (contract §4.7, v24).
 *
 * Move, on a give-up only: put back the acceptance-time goal of everything the
 * task still owed, and report how many rows that latched -- `total` was fixed at
 * acceptance, and the rows a runner never reached have no other reporter
 * (contract §4.7 B2/B3).
 */
export function createTaskHooks(deps: TaskHookDeps): TaskHooks {
  const { db, serverEvents } = deps;
  const now = deps.now ?? (() => Date.now());
  return {
    onTaskProgress(task) {
      // The scheduler hands over a row it has just re-read, so these are the
      // stored counters rather than the claim-time snapshot (`scheduler.ts`).
      emitTaskProgress(serverEvents, {
        accountId: task.account_id,
        taskId: task.id,
        total: task.total,
        updated: task.updated,
        failed: task.failed,
      });
    },
    onTaskSettled(task, payload) {
      // The event is the settlement's announcement, so it must survive a failing
      // obligation: the scheduler's own catch would otherwise swallow the
      // transport notification along with the rollback error, leaving a renderer
      // waiting for a task that is already terminal on disk.
      try {
        settleTaskObligations(db, now, task, payload);
      } finally {
        emitTaskSettled(serverEvents, { accountId: task.account_id, taskId: task.id, status: task.status });
      }
    },
    onTaskPermanentFailure(task) {
      if (task.kind === "move") {
        const { latched } = revertMoveFailures(db, task, pendingMoveItemIds(db, task));
        if (latched) reportTaskProgress(db, task.id, { failed: latched }, now());
        return;
      }
      if (task.kind === "undo") {
        // The undo's answer to `revertMoveFailures`: it has nothing to give back
        // (a restore owns no move goal), only the arithmetic to close. The
        // runner deliberately counts a retryable refusal as nothing, so a task
        // the scheduler gives up on still owes `updated + failed < total`; this
        // latches exactly those rows and reports the number it latched. The
        // helper's predicate is the same one the runner reads, so a second call
        // (the settlement hook may have run first) latches 0 and reports 0.
        const latched = failPendingUndoItems(db, task);
        if (latched) reportTaskProgress(db, task.id, { failed: latched }, now());
        return;
      }
      if (task.kind === "flags") {
        // Read, not taken from the row the hook was handed: that row is the
        // *claim-time* snapshot plus a terminal status (`scheduler.ts:107-118`),
        // and `reportTaskProgress` is an unclamped `failed = failed + ?`, so a
        // stale `updated` would be written into the ledger for good. The
        // difference is unreachable today -- the flags runner's one report is
        // followed immediately by its return, so no path both reports and gives
        // up -- and this read is a guardrail rather than a fix (contract §10.10
        // ④). `?? task` because a row that vanished under the hook is not a
        // reason to skip the arithmetic.
        const owed = unreportedUnits(taskRow(db, task.id) ?? task);
        if (owed) reportTaskProgress(db, task.id, { failed: owed }, now());
      }
    },
  };
}

/**
 * What a settlement owes the task's own kind: the send placeholder / flags
 * rollback / marker clearing / the undo's book-keeping.
 *
 * Split out of `createTaskHooks` so the SSE announcement can sit in a `finally`
 * around it. Its early returns are per kind, so folding the emission into this
 * body would have made it conditional on the kind -- exactly the silent-drop
 * failure G12 exists to prevent.
 */
function settleTaskObligations(
  db: DatabaseHandle,
  now: () => number,
  task: TaskRow,
  payload: unknown,
): void {
  if (task.kind === "send") {
    if (task.status !== "completed") retirePendingSentRow(db, task, now());
    return;
  }
  if (task.kind === "undo") {
    // A `completed` undo has settled every row it owns (the runner settles
    // provider failures as it goes); latching anything then would invent
    // failures. Every other terminal status means the reverse stopped with
    // rows it could not send -- `cancelled` and *the give-up* both arrive here,
    // and the give-up also reaches `onTaskPermanentFailure`; the latch is
    // idempotent so whichever runs second reports 0.
    if (task.status !== "completed") {
      const latched = failPendingUndoItems(db, task);
      if (latched) reportTaskProgress(db, task.id, { failed: latched }, now());
    }
    return;
  }
  if (task.kind !== "flags") return;
  if (task.status !== "completed") revertRefusedFlagsTargets(db, payload, task.id);
  clearConfirmedFlagsMarkers(db, frozenFlagsMessageIds(payload), task.id);
}

export type TaskRunnerDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  /**
   * Where a committed task's `start()` lands. Only the flags runner needs one:
   * its historical `{ids|messageId, patch}` spelling serves itself by
   * **accepting** the patch afresh (`kinds/flags.ts`), and an acceptance commits
   * tasks of its own. The dependency is real rather than incidental, which is
   * also why `CommitTaskDeps.scheduler` is a one-method interface -- the
   * scheduler is built from the registry that holds this runner, so something has
   * to break the cycle.
   */
  starter: TaskStarter;
  accessTokenProvider?: AccountAccessTokenProvider;
  /** Forwarded to the runners under whichever name each of them uses. */
  agentMailEvents?: AgentMailEventSink;
  /** The send runner's attachment staging directory (runtime config). */
  outboundAttachmentDirectory: string;
  /** The send runner's Sent-folder verification pass; required there, so required here. */
  scheduleSentVerification: (submissionId: string) => void;
  /**
   * The app's event bus and its shutdown signal, for the move runner's reconcile
   * kick: the kick publishes `mail.synced` itself now that it owns the pass
   * (the routes used to), and the signal is what lets process shutdown interrupt
   * that pass without letting a client's navigation do the same.
   */
  serverEvents?: ServerEventBus;
  syncAbortSignal?: AbortSignal;
  /**
   * The runtime's new-mail notification pipeline, for `snooze` (a released
   * message joins the same toast/badge path as a freshly synced one). Optional
   * because the runner's durable obligation is the column; a host without a
   * pipeline still gets the message back.
   */
  onSnoozeReleased?: SnoozeRunnerDeps["onSnoozeReleased"];
};

/**
 * Fills a registry with the kinds this layer implements: `move`, `flags`,
 * `undo`, `send`, `snooze`.
 *
 * Those five are what the app's own write paths produce, plus (for the first
 * four) what the migration can produce. The migration never produces `snooze`:
 * the old build wrote the column with no task behind it, so those rows are
 * reconciled by `releaseDueSnoozedMessages` at startup and in the sync pass,
 * not by a runner. `draft-discard` and `filter` are reserved but deliberately
 * unproduced: drafts and filter rules stay synchronous (contract §2.1, v41).
 * `agent-apply` is likewise unproduced -- Agent writes reuse `send`/`flags`/
 * `move` through their injected seams (`agent/mail-write-seams.ts`). An
 * unregistered kind is not a retryable miss: the scheduler settles
 * it `failed` with `no_runner` on the first sighting, having never run anything
 * (`scheduler.ts`). `tests/task-wiring.test.ts` asserts the floor at runtime.
 *
 * The optional deps are spread conditionally rather than passed as `undefined`
 * because `exactOptionalPropertyTypes` is on.
 */
export function registerTaskRunners(registry: TaskRegistry, deps: TaskRunnerDeps): void {
  const { db, masterKey, starter, agentMailEvents } = deps;
  const account = {
    db,
    masterKey,
    ...(deps.accessTokenProvider ? { accessTokenProvider: deps.accessTokenProvider } : {}),
  };
  const agent = agentMailEvents ? { agentMailEvents } : {};

  registry.register("move", createMoveRunner({
    ...account,
    ...agent,
    ...(deps.serverEvents ? { serverEvents: deps.serverEvents } : {}),
    ...(deps.syncAbortSignal ? { syncAbortSignal: deps.syncAbortSignal } : {}),
  }));
  registry.register("undo", createUndoRunner({
    ...account,
    ...agent,
    ...(deps.serverEvents ? { serverEvents: deps.serverEvents } : {}),
    ...(deps.syncAbortSignal ? { syncAbortSignal: deps.syncAbortSignal } : {}),
  }));
  registry.register("flags", createFlagsRunner({
    ...account,
    scheduler: starter,
    // `flags` names this dep `agentEvents`, the others `agentMailEvents`.
    ...(agentMailEvents ? { agentEvents: agentMailEvents } : {}),
    ...(deps.serverEvents ? { serverEvents: deps.serverEvents } : {}),
    ...(deps.syncAbortSignal ? { syncAbortSignal: deps.syncAbortSignal } : {}),
  }));
  registry.register("send", createSendRunner({
    db,
    masterKey,
    outboundAttachmentDirectory: deps.outboundAttachmentDirectory,
    scheduleSentVerification: deps.scheduleSentVerification,
    ...(deps.accessTokenProvider ? { accessTokenProvider: deps.accessTokenProvider } : {}),
    ...(agentMailEvents ? { agentEvents: agentMailEvents } : {}),
  }));
  registry.register("snooze", createSnoozeRunner({
    db,
    masterKey,
    ...(deps.onSnoozeReleased ? { onSnoozeReleased: deps.onSnoozeReleased } : {}),
  }));
}

export type TaskExecutionDeps = Omit<TaskRunnerDeps, "starter"> & {
  /** One clock for the hooks and the scheduler. */
  now?: () => number;
  /** Due-tick and backoff bounds; tests shorten them so a retry case does not
   * cost the suite a 90-second ladder. */
  dueTickMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

/**
 * The registry, the hooks and a live scheduler, built in that order.
 *
 * The caller still has to `resume()` -- that is where the legacy
 * `resumePending()` sat (`app.ts:375` against the pre-batch-4 revision; deleted
 * with the write layer), and keeping it a separate call is what
 * lets a test drive a real task with `start()` + `drain()` without a startup
 * sweep. It is also the reason the construction order below is safe: the only
 * three paths into the registry are the due tick, `resume()` and `start()`, and
 * all three are either unable to run inside this synchronous block or are the
 * caller's to make after this returns. So a task can never be claimed before its
 * kind is registered, by construction rather than by timing.
 */
export function createTaskExecution(deps: TaskExecutionDeps): TaskScheduler {
  const registry = createTaskRegistry();
  const hooks = createTaskHooks({
    db: deps.db,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.serverEvents ? { serverEvents: deps.serverEvents } : {}),
  });
  const scheduler = startTaskScheduler({
    db: deps.db,
    masterKey: deps.masterKey,
    registry,
    hooks,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.dueTickMs !== undefined ? { dueTickMs: deps.dueTickMs } : {}),
    ...(deps.retryBaseMs !== undefined ? { retryBaseMs: deps.retryBaseMs } : {}),
    ...(deps.retryMaxMs !== undefined ? { retryMaxMs: deps.retryMaxMs } : {}),
  });
  registerTaskRunners(registry, {
    db: deps.db,
    masterKey: deps.masterKey,
    starter: scheduler,
    outboundAttachmentDirectory: deps.outboundAttachmentDirectory,
    scheduleSentVerification: deps.scheduleSentVerification,
    ...(deps.accessTokenProvider ? { accessTokenProvider: deps.accessTokenProvider } : {}),
    ...(deps.agentMailEvents ? { agentMailEvents: deps.agentMailEvents } : {}),
    ...(deps.serverEvents ? { serverEvents: deps.serverEvents } : {}),
    ...(deps.syncAbortSignal ? { syncAbortSignal: deps.syncAbortSignal } : {}),
    ...(deps.onSnoozeReleased ? { onSnoozeReleased: deps.onSnoozeReleased } : {}),
  });
  return scheduler;
}
