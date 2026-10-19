/**
 * The task layer's public surface.
 *
 * The intended entry point: named exports rather than `export *` on purpose,
 * because the point of the layer is that a caller cannot reach past it into the
 * scheduler's bookkeeping, and a wildcard would republish every internal the
 * moment one is added.
 *
 * Nothing enforces that yet -- there is no lint rule for this directory -- and
 * `db-schema.ts` already imports `./tasks/schema.js` directly, because it needs
 * the DDL to build the full-schema string; the layer's own tests reach inside
 * too. The rule that *is* contract-scoped is narrower: `routes` import this file
 * and nothing deeper.
 *
 * What is deliberately NOT here: the low-level row writers the migration and the
 * scheduler use (`insertTaskRow`, `settleTask`, `claimTaskRow`,
 * `releaseTaskForRetry`). A runner settles itself by throwing `TaskAbortError`,
 * so nothing outside the layer needs to write a status directly. `settleTask`
 * and `insertTaskItems` used to be exported and are not: nothing outside the
 * layer called either, and republishing them contradicted the sentence above.
 *
 * The migration is exported because mounting it is a caller's job, not the
 * layer's, and both mounts have landed (4b): `openDatabase` calls the backfill
 * inside the transaction it already owns (`db.ts`), and `buildApp` runs the seal
 * pass once the master key is in hand (`app.ts`). The execution mount landed
 * earlier, with the atomic switch, so `app.ts` builds the only execution this
 * process has. The
 * settlement surface is exported because it is what the task hooks call, and the
 * hooks are `wiring.ts` -- which is itself exported because assembling the three
 * pieces is `buildApp`'s job, not the layer's.
 *
 * Five kinds are implemented -- `move`, `flags`, `send`, `snooze` and `undo` -- and
 * each exports the runners `buildApp`'s registry construction registers: `flags`'
 * and `move`'s acceptances (the two flags routes and the two batch paths call
 * them), `move`'s settlement (the app's task hook), `send`'s runner (whose
 * submission id comes from the task, not from a due-time query), `snooze`'s two
 * acceptances and its release runner (the two routes that used to write
 * `messages.snoozed_until` directly), and `undo`'s acceptance (what the
 * batch-jobs undo endpoint reaches through `commitJobUndo`, in place of the
 * deleted `undoBatchJob`). The layer's own tests import the kinds directly
 * (`./kinds/move.js`) rather than through here, because a test that pins a runner
 * wants its declaration, not the surface.
 */

export {
  TASK_DEFAULT_MAX_ATTEMPTS,
  TASK_TERMINAL_ROW_TTL_MS,
  claimNextTask,
  commitTask,
  openTaskPayload,
  recordTask,
  reportTaskProgress,
  taskItems,
  taskProgress,
  taskRow,
  type CommitTaskDeps,
  type TaskHandle,
} from "./store.js";
export {
  LEGACY_QUEUE_KINDS,
  migrateTaskStorageInTransaction,
  sealMigratedTaskPayloads,
  type TaskMigrationResult,
} from "./migrate.js";
export {
  clearConfirmedFlagsMarkers,
  clearOrphanedFlagsMarkers,
  flagsProtectedMessageIds,
  frozenFlagsMessageIds,
  mailboxesStagedBy,
  revertRefusedFlagsTargets,
} from "./settlement.js";
// The move kind: its settlement half (what a task's terminal status obliges the
// app to put back) and its runner. The settlement functions need the move
// mechanics (`moveStatements`), so they live in the
// `move` runner's own module rather than in `settlement.ts` -- see §4.7 and that
// file's header. The connection session stays module-private: the undo runner,
// which is the other thing that needs it, is inside this layer and imports its
// sibling directly.
export {
  acceptMoveTask,
  createMoveRunner,
  pendingMoveItemIds,
  revertMoveFailures,
  // The two entries that call the acceptance read the refusals it returns, and
  // the wording those refusals are answered with is the routes' (`kinds/move.ts`
  // carries a reason and no text). So the reason union is on the surface while
  // `MoveRefusal` -- the id-plus-reason pairing those same routes read -- stays
  // out: it is spelled inline in `MoveTaskAcceptance`, which is what a caller
  // holds.
  type MoveRefusalReason,
  type MoveRunnerDeps,
  type MoveTaskAcceptance,
  type MoveTaskDestination,
  type MoveTaskPayload,
  type RevertedMoveFailures,
} from "./kinds/move.js";
// The flags kind. Its acceptance half is exported for the same reason the move
// kind's settlement half is: the write paths that call it are batch 2's atomic
// switch, which is the change this layer exists for -- and those paths have
// landed, so the flags routes and the batch acceptance are `acceptFlagsTask`
// callers. `acceptFlagsTaskInTransaction` is deliberately NOT
// republished -- its caller inside this layer is `commitUndoTask`, a sibling
// module, so it needs no name on the public surface (the same standard the header
// applies to `settleTask`).
export {
  acceptFlagsTask,
  createFlagsRunner,
  type FlagsTaskAcceptance,
  type FlagsTaskDeps,
  type FlagsTaskPayload,
  type FrozenFlagsPayload,
} from "./kinds/flags.js";
// The send kind. The acceptance and the runner are both republished: the ledger
// row IS the payload (`outbound_submissions.request_json` + `encrypted_details`),
// so the task points at it by `submission_id` and carries no copy of it -- but the
// acceptance is what makes the route's answer immediate, since it commits the
// ledger row, its uploads' links, the optimistic Sent row and the task in one
// transaction while reading no attachment file. `SendTaskDeps` carries the master
// key, the attachment directory, the access-token provider and the
// Sent-verification pass, i.e. exactly what `buildApp` already holds.
// `cancelScheduledSend` is the other end of the same lifetime: a cancelled
// schedule deletes its task in the transaction that deletes the ledger row (the
// acceptance's counterpart, and the reason `submission_id` being `SET NULL` does
// not leave a ghost behind). It is the whole seam on purpose -- its two halves are
// not exported, so no caller can run one without the other, which the routes layer
// could otherwise do by opening its own transaction around them.
export {
  acceptPreparedSendTask,
  acceptSendTask,
  cancelScheduledSend,
  createSendRunner,
  type AcceptPreparedSendInput,
  type AcceptSendInput,
  type SendAcceptance,
  type SendTaskDeps,
} from "./kinds/send.js";
// The undo kind. `commitUndoTask` is the acceptance `commitJobUndo` drives -- the
// batch-jobs undo endpoint calls that alias, one parent at a time (it replaces the
// deleted `undoBatchJob`'s three entries and answers with
// `{ok, taskIds}` / a refusal reason), and `createUndoRunner` is what the registry
// registers for `kind='undo'` -- which only a move parent produces, since a flags
// parent's reverse is committed as `flags` tasks. `failPendingUndoItems` is the
// undo's half of the permanent-failure hook (the analogue of `revertMoveFailures`,
// which has no work to do here because a restore writes no move goal). What is
// deliberately NOT here: `undoRefusal`, `planFlagsUndo`, `pendingUndoItems` and
// `settleUndoItem`, whose only callers are inside this layer. `undoRefusal` in
// particular is not a convenience for the route: the route reports the reason it
// is handed, it does not re-derive one.
// The snooze kind: the one pure-local write, and the one task whose goal state
// is already committed by the acceptance. Its three names are the two routes'
// acceptances and the release runner; the equality guard that makes re-snoozing
// safe stays inside the file, because neither route may reason about it.
export {
  acceptSnoozeTask,
  cancelSnoozeTask,
  createSnoozeRunner,
  type AcceptSnoozeInput,
  type SnoozeAcceptance,
  type SnoozeRunnerDeps,
  type SnoozeTaskDeps,
  type SnoozeTaskPayload,
} from "./kinds/snooze.js";
export {
  commitUndoTask,
  createUndoRunner,
  failPendingUndoItems,
  type UndoOutcome,
  type UndoRefusalReason,
  type UndoRunnerDeps,
  type UndoTaskPayload,
} from "./kinds/undo.js";
// The batch-job compatibility alias: what `routes/batch-jobs.ts` reads and calls
// now that the acceptances commit tasks instead of legacy rows. All four names are
// the route's -- `jobSnapshot` is `GET /:id` (`:117`; its `null` is the route's
// 404), and `commitJobUndo` is `POST /:id/undo` (`:126`), which fans out over every
// account of the job because undoing one of them would leave the other behind a
// 200. The two types are the response body the route builds rather than re-derives.
// The read and the five write paths had to switch in one batch -- a job lives in
// exactly one place at a time, so the read could not move on its own without
// 404-ing every job created in between -- and that batch has landed.
export {
  commitJobUndo,
  jobSnapshot,
  type JobAliasKind,
  type JobAliasSnapshot,
  type JobAliasStatus,
  type JobUndoOutcome,
} from "./jobs.js";
export {
  TASK_DUE_TICK_MS,
  TASK_RETRY_BASE_MS,
  TASK_RETRY_MAX_MS,
  TASK_RUN_TIMEOUT_MS,
  TaskAbortError,
  startTaskScheduler,
} from "./scheduler.js";
export { createTaskRegistry } from "./registry.js";
// The wiring: the three pieces `buildApp` assembles. `createTaskExecution`
// is the one production calls -- it composes the registry, the hooks and a
// scheduler, and hands back the scheduler (whose `resume()` the caller owns:
// `buildApp` calls it where `operationQueue.resumePending()` used to sit, and
// that queue has since been deleted). The other two are exported because they
// are the halves a test reaches for when it wants to see hook calls it cannot
// observe through a database effect, and because `createTaskExecution` is
// nothing but those two plus `startTaskScheduler`.
export {
  createTaskExecution,
  createTaskHooks,
  registerTaskRunners,
  type TaskExecutionDeps,
  type TaskHookDeps,
  type TaskRunnerDeps,
} from "./wiring.js";
export {
  PAYLOAD_ENVELOPE_VERSION,
  PAYLOAD_VERSION_UNSEALED,
  payloadFingerprint,
  sealPayload,
  type PayloadAad,
  type SealedPayloadRow,
} from "./envelope.js";
export {
  TASK_ERROR_NO_RUNNER,
  TASK_KINDS,
  TASK_SCOPES,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_UNDO_WINDOW_MS,
  isTaskKind,
  isTaskStatus,
  isTerminalTaskStatus,
  type SchedulerDeps,
  type TaskHooks,
  type TaskItemRow,
  type TaskItemSpec,
  type TaskKind,
  type TaskProgress,
  type TaskRegistry,
  type TaskRow,
  type TaskRunner,
  type TaskScheduler,
  type TaskScope,
  type TaskSpec,
  type TaskStarter,
  type TaskStatus,
  type TaskTerminalStatus,
} from "./types.js";