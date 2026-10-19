import type { DatabaseHandle } from "../../db.js";
import type { AccountAccessTokenProvider } from "../../mail.js";
import type { AgentMailEventSink } from "../../agent/mail-state-events.js";
import { MOVE_LOCATION_UNVERIFIED_ERROR, PENDING_MOVE_RECONCILIATION_ERROR } from "../../message-storage.js";
import { messageFlagNames, type MessageFlagsPatch } from "../../message-flags.js";
import { moveMessageToFolder } from "../../sync-moves.js";
import { resolveMoveDestination, type MessageMoveTarget } from "../../move-destinations.js";
import type { FlagsPushEntry } from "../../flags-outbox.js";
import type { TaskKind, TaskItemSpec, TaskRow, TaskRunner } from "../types.js";
import { TASK_UNDO_WINDOW_MS } from "../types.js";
import { commitTask, openTaskPayload, taskRow, type TaskHandle } from "../store.js";
import { acceptFlagsTaskInTransaction, type FlagsTaskDeps, type FlagsTaskPayload } from "./flags.js";
import { createAccountConnections, isMoveWaitRefusal, type MoveTaskPayload } from "./move.js";

/**
 * The `undo` half of the task layer: the acceptance a user's undo goes through,
 * and the executor of the one reverse that cannot be expressed as a task of its
 * parent's kind (contract §4.7 A).
 *
 * Two halves, deliberately hosted by different mechanisms:
 *
 *   - a `move` parent's undo is a task of its own (`kind='undo'`), because a move
 *     task's payload is one *symbolic* target (`archive`/`trash`/`junk`/`inbox`,
 *     resolved through `resolveMoveDestination`) while an undo restores each
 *     message to its own `origin_mailbox` -- a folder path no symbolic target can
 *     name. This module owns that runner.
 *   - a `flags` parent's undo *is* a flags write, so it commits `flags` tasks
 *     through `acceptFlagsTaskInTransaction` and has no executor of its own. That
 *     is what keeps the reverse on the one pipeline instead of leaving a second
 *     executor alive (`kind='flags'`), exactly as draining an old queue row does.
 *
 * Both halves claim the parent's `undone` mark inside the acceptance's own
 * transaction, so the "one undo per action" guarantee is one commit -- the same
 * shape `acceptFlagsJob`'s `alsoMarkUndone` and `undoMoveJob`'s conditional
 * `UPDATE` had (`batch-jobs.ts:986`/`:1057-1060`, deleted). Neither half is a
 * task in the old sense: a refused undo creates nothing at all (§4.7 A ①).
 */

/** Why an undo was refused. Each maps to one condition; §4.7 A lists them in order. */
export type UndoRefusalReason =
  | "not_found"
  | "unsupported_parent"
  | "not_completed"
  | "already_undone"
  | "no_window"
  | "expired"
  | "inverse_unavailable";

export type UndoOutcome = { ok: true; taskIds: string[] } | { ok: false; reason: UndoRefusalReason };

/**
 * The kinds whose actions offer an undo. Both are user-confirmed batch writes;
 * a single-message move or a send carries no window and is refused as
 * `no_window` rather than this, which is what keeps a wiring mistake ("the
 * acceptance forgot to pass `undoWindowMs`") distinguishable from "this action
 * never offered one" (§4.3b 第 3 条第 9 项 ②).
 */
const UNDOABLE_PARENT_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["move", "flags"]);

/**
 * The parent-side guard, in the order the reason vocabulary is declared.
 *
 * `status !== "completed"` and the completion basis are both taken from the
 * deleted `undoGuard` (`batch-jobs.ts:1006-1015`) verbatim, including the judgement
 * that a parent with no completion timestamp reads as expired -- which is what makes
 * a migrated **flags** record (`jobTaskCompletedAt` nulls it on purpose,
 * `migrate.ts:462-465`) refuse an undo instead of finding its window still open.
 * A migrated `kind='undo'` record never reaches that clause: the kind test above
 * refuses it as `unsupported_parent` first.
 */
export function undoRefusal(parent: TaskRow, now: number): UndoRefusalReason | null {
  if (!UNDOABLE_PARENT_KINDS.has(parent.kind)) return "unsupported_parent";
  if (parent.status !== "completed") return "not_completed";
  if (parent.undone !== 0) return "already_undone";
  if (parent.undo_window_ms === null) return "no_window";
  if (parent.completed_at === null) return "expired";
  if (now - parent.completed_at > parent.undo_window_ms) return "expired";
  return null;
}

/** One reverse write: the ids that share an inverse delta, and that delta. */
type FlagsReverseGroup = { messageIds: string[]; patch: MessageFlagsPatch };

/**
 * The exact inverse of a frozen flags delta, per message.
 *
 * The entry records what the forward write actually applied (`add`/`remove`), so
 * the inverse swaps them. Negating the parent's *patch* instead would
 * over-reverse, and the case is ordinary rather than exotic: a patch
 * `{seen: true, flagged: true}` applied to a message that was already seen
 * produces the entry `add: ["\Flagged"], remove: []`, whose inverse is
 * `{flagged: false}` -- while the uniform negation would mark it unread.
 *
 * `null` means the entry names a flag this vocabulary cannot express. No writer
 * can produce one -- every entry comes from `prepareLocalFlags`, which only ever
 * emits the two names above -- so this is a guard rather than a path: reversing
 * an unexpressible flag would be the one outcome worse than refusing.
 */
function reversePatch(entry: FlagsPushEntry): MessageFlagsPatch | null {
  const patch: MessageFlagsPatch = {};
  for (const flag of entry.add) {
    const bit = FLAG_BIT_BY_NAME.get(flag);
    if (!bit) return null;
    patch[bit] = false;
  }
  for (const flag of entry.remove) {
    const bit = FLAG_BIT_BY_NAME.get(flag);
    if (!bit) return null;
    patch[bit] = true;
  }
  return patch;
}

/** `messageFlagNames` read backwards, so the pairing has one definition. */
const FLAG_BIT_BY_NAME = new Map<string, keyof MessageFlagsPatch>(
  Object.entries(messageFlagNames).map(([bit, name]) => [name, bit as keyof MessageFlagsPatch]),
);

/**
 * The reverse of a `flags` parent, grouped by the delta each message needs.
 *
 * Groups rather than one patch for the whole selection, because the inverse is
 * only uniform over messages the forward write treated identically. Grouping is
 * lossless for the same reason: every id in a group needs exactly that patch, and
 * `acceptFlagsTaskInTransaction` re-derives each message's delta against its
 * current state, so an id the user has already put back is counted `updated`
 * without a second write.
 *
 * The `{patch}` spelling (job-derived rows, `migrate.ts:413-426`) is refused:
 * it records no per-message delta, so `add`/`remove` cannot be reconstructed.
 * Practically unreachable -- such a parent is a migrated record, refused by an
 * earlier clause of the guard (a `flags` row by its null `completed_at`, an
 * `undo` row by its kind) -- but "unreachable" is not a reason to guess at a
 * reverse.
 */
function planFlagsUndo(masterKey: Buffer, parent: TaskRow): { groups: FlagsReverseGroup[] } | { reason: "inverse_unavailable" } {
  const payload = openTaskPayload<FlagsTaskPayload>(masterKey, parent);
  const entries = (payload as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(entries)) return { reason: "inverse_unavailable" };
  const groups = new Map<string, FlagsReverseGroup>();
  for (const entry of entries as FlagsPushEntry[]) {
    const patch = reversePatch(entry);
    if (!patch) return { reason: "inverse_unavailable" };
    const key = JSON.stringify(patch);
    const group = groups.get(key);
    if (group) group.messageIds.push(entry.id);
    else groups.set(key, { messageIds: [entry.id], patch });
  }
  return { groups: [...groups.values()] };
}

/**
 * The move parent's target, or `undefined` when it carries none.
 *
 * A migrated record's payload uses the other spelling (`{patch}`), so this reads
 * `undefined` for it and the runner skips its destination guard -- the legacy's
 * `parent.target ?? undefined` (`batch-jobs.ts:1072`, deleted), kept because a
 * target-less parent is a real shape rather than an error.
 */
function moveUndoTarget(masterKey: Buffer, parent: TaskRow): MessageMoveTarget | undefined {
  const payload = openTaskPayload<MoveTaskPayload>(masterKey, parent);
  // A folder move has no symbolic target to reverse to: the undo restores each
  // message to the folder it left, which is what `origin_mailbox` already holds.
  return payload && "target" in payload ? payload.target : undefined;
}

/**
 * Everything an undo can refuse or throw on **before** it claims the parent: the
 * guard, then the payload.
 *
 * One definition, called by both the single undo and the batch fan-out
 * (`jobs.ts`'s `commitJobUndo` pre-checks every member with it). The fan-out's
 * pre-check used to be `undoRefusal` alone, which is one clause short of what
 * `commitUndoTask` answers before its transaction: `inverse_unavailable` is read
 * from the parent's *payload*, so a job whose second member carried a
 * `{patch}`-only payload would have claimed and reversed the first member, then
 * reported the refusal -- telling the user the undo did not happen while one
 * account's messages were already on their way back. Today's only `{patch}`
 * parents happen to be refused by an earlier clause (a migrated record's null
 * `completed_at`), and that is an accident of two other files, not a property of
 * this fan-out.
 *
 * `openTaskPayload` *throws* on an envelope this build cannot read. Reading it
 * here is what keeps that inside the pre-check too: a throw before any claim
 * leaves nothing half-done, where a throw during the loop would leave every
 * earlier member reversed.
 *
 * The fan-out pays for the flags plan twice (here, then again in the work). A
 * decrypt and a parse per member is the price of the pre-check being the same
 * function rather than a copy of its first three lines.
 */
export function undoPreflightRefusal(deps: { masterKey: Buffer }, parent: TaskRow, now: number): UndoRefusalReason | null {
  const refusal = undoRefusal(parent, now);
  if (refusal) return refusal;
  if (parent.kind === "flags") {
    const plan = planFlagsUndo(deps.masterKey, parent);
    return plan && "reason" in plan ? plan.reason : null;
  }
  // No refusal of its own, so the read is here for its throw.
  if (parent.kind === "move") moveUndoTarget(deps.masterKey, parent);
  return null;
}

/**
 * The undo's scope, materialized from the parent's own selection rows.
 *
 * `changed = 1 AND origin_mailbox IS NOT NULL` -- deliberately without the
 * legacy's `failed = 0` (`batch-jobs.ts:1027`, deleted). The latch records the
 * *batch* giving up on a message, which says nothing about where that message is now:
 * leaves `changed = 1` (`kinds/move.ts:172`, and that is what keeps the row in
 * this selection), and afterwards the message can reach the batch's destination
 * by a route the batch never sent -- the user moving it there themselves being
 * the plainest, and the shape the batch's own accounting already reads as
 * "arrived" (`neverArrived`, `kinds/move.ts:224`). Excluding those rows would
 * spend the one undo, report success, and leave the message at the destination.
 * Including them cannot over-restore: the runner's destination guard hands any
 * message that is not at the batch's destination to the newer decision, and one
 * that never moved is at its origin, which the guard ahead of that one answers
 * `updated` without a provider call.
 *
 * `origin_mailbox IS NOT NULL` is the other half, and it is what keeps a `flags`
 * parent out of this scope: those rows are materialized `changed = 1` with no
 * origin at all (`kinds/flags.ts:223`), so what is left is exactly the rows with
 * somewhere to be returned to.
 *
 * `destination_mailbox` is left NULL on purpose. The undo writes no move goal at
 * acceptance -- `moveMessageToFolder` claims one per message as it restores -- and
 * leaving the column empty also makes a mis-keyed settlement call harmless:
 * `revertMoveFailures` hands `null` to `neverArrived`, which answers `false`
 * without touching a count.
 */
function undoItemSpecs(db: DatabaseHandle, parentTaskId: string): TaskItemSpec[] {
  const rows = db.prepare(`
    SELECT message_id, origin_mailbox FROM task_items
    WHERE task_id = ? AND changed = 1 AND origin_mailbox IS NOT NULL
    ORDER BY rowid
  `).all(parentTaskId) as Array<{ message_id: string; origin_mailbox: string }>;
  return rows.map((row) => ({ messageId: row.message_id, changed: true, originMailbox: row.origin_mailbox }));
}

/**
 * Accepts an undo of one task: the guard, the one-undo claim, the reverse work,
 * and the `start()` that joins it to the account's chain.
 *
 * The claim and the reverse commits are one transaction, so a crash or a throw
 * between them leaves the parent unclaimed and the undo retryable -- the property
 * `acceptFlagsJob`'s comment spells out (a lost mark would consume the one undo
 * without leaving the reverse behind). The claim's own `AND status = 'completed'`
 * re-verifies the two facts that a concurrent undo could have changed; the window
 * cannot change under it, because `completed_at` is already written.
 *
 * The deps are the flags acceptance's, and that is not a naming accident: the
 * flags branch of this function *is* a flags acceptance, so it needs exactly the
 * same `db`/`masterKey`/`scheduler` plus the two optional providers.
 */
export function commitUndoTask(deps: FlagsTaskDeps, parentTaskId: string, now: number = Date.now()): UndoOutcome {
  const parent = taskRow(deps.db, parentTaskId);
  if (!parent) return { ok: false, reason: "not_found" };
  const refusal = undoPreflightRefusal(deps, parent, now);
  if (refusal) return { ok: false, reason: refusal };
  // Planned for the work; the pre-check above has already read and refused it, so
  // the `"reason"` branch here is unreachable -- kept because it is the
  // discriminant the compiler needs to see `groups`. A property of the parent's
  // payload, not of the write, so it is answered before the transaction starts and
  // the transaction stays "claim then write".
  const flagsPlan = parent.kind === "flags" ? planFlagsUndo(deps.masterKey, parent) : null;
  if (flagsPlan && "reason" in flagsPlan) return { ok: false, reason: flagsPlan.reason };
  const target = parent.kind === "move" ? moveUndoTarget(deps.masterKey, parent) : undefined;

  const handles = deps.db.transaction((): TaskHandle[] | null => {
    const claimed = deps.db
      .prepare("UPDATE tasks SET undone = 1 WHERE id = ? AND undone = 0 AND status = 'completed'")
      .run(parent.id).changes;
    if (claimed !== 1) return null;
    if (flagsPlan) {
      const created: TaskHandle[] = [];
      for (const group of flagsPlan.groups) {
        // The reverse is itself undoable, with the same window a forward batch
        // flags write gets. That is the legacy's behaviour, not a new symmetry:
        // `undoFlagsJob` accepted its reverse through the same
        // `acceptFlagsJob`, which set `BATCH_JOB_UNDO_WINDOW_MS` on every row it
        // inserted (`batch-jobs.ts:383-385`, deleted), so "undo the undo" worked for
        // flags and still does. The move half cannot follow it -- the reverse of a
        // restore would have to name each message's own destination, which the
        // `move` kind's symbolic target cannot express -- and the legacy agreed:
        // `undoMoveJob` returned no new job at all, so there was nothing to undo.
        created.push(...acceptFlagsTaskInTransaction(deps, { ...group, undoWindowMs: TASK_UNDO_WINDOW_MS }).handles);
      }
      return created;
    }
    const items = undoItemSpecs(deps.db, parent.id);
    // No selection, no task -- and the parent is claimed either way, so the one
    // undo is spent. Both halves answer an empty reverse the same way, and the
    // move half has to match the flags half by construction rather than by luck:
    // `acceptFlagsTaskInTransaction` skips every entry whose delta is empty
    // (`kinds/flags.ts:191`), so a reverse whose messages already hold the target
    // state commits nothing. A 0-total `undo` task would be a durable row whose
    // only future is to settle as `0/0` -- the phantom executor the legacy's
    // `undoMoveJob` never created either (it wrote no `batch_jobs` row at all),
    // and the one shape a caller cannot act on: there is no id to show, poll or
    // undo. What the user gets instead is `taskIds: []`, which the route has to
    // accept as "the reverse is already in force".
    if (!items.length) return [];
    return [commitTask(deps, {
      accountId: parent.account_id,
      kind: "undo",
      scope: items.length > 1 ? "batch" : "single",
      parentId: parent.id,
      total: items.length,
      items,
      ...(target === undefined ? {} : { payload: { target } }),
    })];
  })();
  // The loser of two concurrent undos: the guard above read `undone = 0`, the
  // claim found it already taken, and the rollback left nothing behind. Tested
  // against `null` rather than falsiness, because the empty reverse above is a
  // legitimate success and `[]` is the only other thing this can be.
  if (handles === null) return { ok: false, reason: "already_undone" };
  for (const handle of handles) handle.start();
  return { ok: true, taskIds: handles.map((handle) => handle.id) };
}

/** What an `undo` task's payload carries. */
export type UndoTaskPayload = { target?: MessageMoveTarget };

export type UndoRunnerDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  accessTokenProvider?: AccountAccessTokenProvider;
  agentMailEvents?: AgentMailEventSink;
};

/**
 * The undo's own retryable set: the move kind's wait-your-turn pair, plus the two
 * refusals that mean "someone else owns where this message is right now".
 *
 * The two additions are the ones `move` reads as permanent, and the difference is
 * the reason this set is stated rather than reused. `batchMoveMessages` has
 * nothing left to send when sync owns a row's outcome, so retrying it would only
 * burn attempts; the undo *does* have something to send -- the restore -- and both
 * states change under sync's next pass (`PENDING_MOVE_RECONCILIATION_ERROR` is
 * cleared by `reconcilePendingMove`, `sync.ts:459`; the unverified-location one is
 * what a refresh of the target folder resolves). Waiting is therefore the honest
 * answer, and the attempts bound the wait: a state that never clears ends in a
 * counted `failed` instead of a silent skip.
 */
const RETRYABLE_UNDO_REFUSALS = new Set<string>([PENDING_MOVE_RECONCILIATION_ERROR, MOVE_LOCATION_UNVERIFIED_ERROR]);

function isRetryableUndoRefusal(message: string): boolean {
  return isMoveWaitRefusal(message) || RETRYABLE_UNDO_REFUSALS.has(message);
}

/** The ids this undo still owes, in selection order: the same predicate its own latch writes. */
function pendingUndoItems(db: DatabaseHandle, taskId: string): Array<{ id: string; fromMailbox: string }> {
  return db.prepare(`
    SELECT message_id AS id, origin_mailbox AS fromMailbox FROM task_items
    WHERE task_id = ? AND changed = 1 AND failed = 0 AND origin_mailbox IS NOT NULL
    ORDER BY rowid
  `).all(taskId) as Array<{ id: string; fromMailbox: string }>;
}

/**
 * Latches one item and counts it, in one transaction.
 *
 * The conditional `UPDATE` is the claim: a row already latched by another path is
 * not counted again, the same guard `revertMoveFailures` uses for the same reason.
 * The report rides in the transaction with the latch, which is what makes the
 * counter unable to disagree with the rows -- and why an exception thrown later
 * cannot take a count with it.
 */
function settleUndoItem(
  db: DatabaseHandle,
  taskId: string,
  messageId: string,
  outcome: "updated" | "failed",
  report: (delta: { updated?: number; failed?: number }) => void,
): void {
  db.transaction(() => {
    const latched = db.prepare(
      "UPDATE task_items SET changed = ?, failed = ? WHERE task_id = ? AND message_id = ? AND changed = 1 AND failed = 0",
    ).run(outcome === "failed" ? 1 : 0, outcome === "failed" ? 1 : 0, taskId, messageId).changes;
    if (latched !== 1) return;
    report(outcome === "failed" ? { failed: 1 } : { updated: 1 });
  })();
}

/**
 * The undo's half of the permanent-failure obligation: every entry the task still
 * owes is latched `failed`, and the number latched comes back for the hook to
 * report.
 *
 * This is the `undo` kind's answer to `revertMoveFailures`, and the difference is
 * entirely on the giving-back side, which the undo does not have: a restore writes
 * no move goal and no folder departure at acceptance (`destination_mailbox` is
 * NULL, `undoItemSpecs` own doc), so there is nothing to hand back and nothing to
 * refund. What is left is the arithmetic -- `total` was fixed when the task was
 * committed, the runner only ever counts `changed = 1` entries, and a retryable
 * refusal deliberately counts nothing -- so a task the scheduler gives up on has
 * `updated + failed < total` until this latches the remainder. The hook reports the
 * return value (`reportTaskProgress` does not guard a terminal row), which is the
 * same division of labour §4.7 records for the move kind.
 *
 * One statement rather than a loop: the latch is uniform over the rows this task
 * still owes, so `changes` is the count (every row the predicate matches moves
 * `failed` 0 -> 1, and the predicate is what makes a second call return 0).
 *
 * `origin_mailbox IS NOT NULL` is the same scope `pendingUndoItems` reads and the
 * same scope `undoItemSpecs` materialized, so on this kind's own rows it changes
 * nothing -- every row an undo owns has an origin. What it buys is the mis-keyed
 * call: a `flags` task's rows are `changed = 1` with no origin (`kinds/flags.ts:223`),
 * and latching *those* would corrupt a live push's selection while its counts stayed
 * consistent (`updated + failed == total` holds either way), which is the failure
 * mode nothing downstream would notice.
 */
export function failPendingUndoItems(db: DatabaseHandle, task: Pick<TaskRow, "id">): number {
  return db.prepare(
    "UPDATE task_items SET failed = 1 WHERE task_id = ? AND changed = 1 AND failed = 0 AND origin_mailbox IS NOT NULL",
  ).run(task.id).changes;
}

/**
 * Restores a move, one message at a time, on one connection per account.
 *
 * Message by message rather than in batches, because each entry has its own
 * origin folder, its own "the user re-moved it since" guard and its own latch --
 * there is nothing to aggregate (the legacy reasoned the same way,
 * `batch-jobs.ts:1074-1079`, deleted), and the connection is shared precisely so
 * that per-message work does not cost a dial per message.
 *
 * Three of the legacy's four judgements survive (`runUndo`,
 * `batch-jobs.ts:1082-1117`, deleted) and are the three settled ones: at its
 * origin already, re-moved elsewhere since, or restorable. A missing cache row is
 * settled `failed` (a retry cannot create it),
 * and a row whose move state is claimed is settled *nowhere* -- it is neither
 * counted nor latched, and the attempt fails so the retry finds it again
 * (§4.7 A ④: a `confirmed` row keeps `mailbox` reading the source while
 * `EFFECTIVE_MAILBOX_SQL` files it at the destination, so neither the "already
 * there" comparison nor the destination guard may be trusted on it).
 *
 * Because a refusal has to fail the attempt, and the point of a per-entry latch is
 * that it is *kept*, the refusal is collected and thrown after the loop rather than
 * the moment it is met -- the ordering the move runner uses for the same reason
 * (`kinds/move.ts:445-460`). A refused entry counts nothing, so the entries that do
 * settle here keep their counts, and the retry re-reads what is still owed: the
 * ids a refusal left behind, and only those.
 *
 * When the runner returns, `updated + failed == total`. The entries it settled are
 * the whole of that arithmetic, so an entry it refused must be one it did not
 * settle -- which is why the refusal is a throw and not a `continue`.
 */
export function createUndoRunner(deps: UndoRunnerDeps): TaskRunner<UndoTaskPayload> {
  return async ({ task, payload, report }) => {
    const entries = pendingUndoItems(deps.db, task.id);
    if (entries.length === 0) return;
    const target = payload?.target;
    const connections = createAccountConnections(deps.db, deps.masterKey, deps.accessTokenProvider);
    // The first "not yet" of the attempt, thrown after the loop so the entries
    // after it still get their turn: these refusals are per-message conditions (a
    // move state sync has to reconcile), not the account-level pair the move
    // runner stops at.
    let refusal: Error | null = null;
    try {
      for (const entry of entries) {
        const message = deps.db
          .prepare("SELECT account_id, mailbox, pending_move_state FROM messages WHERE id = ?")
          .get(entry.id) as { account_id: string; mailbox: string; pending_move_state: string | null } | undefined;
        if (!message) {
          // Gone from the cache: there is nothing to restore and no retry can
          // create the row, so this is final rather than retryable.
          settleUndoItem(deps.db, task.id, entry.id, "failed", report);
          continue;
        }
        if (message.pending_move_state !== null) {
          // An in-flight or unreconciled move owns where this message is, and the
          // column cannot be read while it does. Sync's reconcile is what changes
          // that (`reconcilePendingMove`, `sync.ts:459`), so "wait" is the answer
          // the retryable set encodes.
          refusal ??= new Error(PENDING_MOVE_RECONCILIATION_ERROR);
          continue;
        }
        if (message.mailbox === entry.fromMailbox) {
          // Already back (or the move was a no-op for it).
          settleUndoItem(deps.db, task.id, entry.id, "updated", report);
          continue;
        }
        if (target) {
          const destination = resolveMoveDestination(deps.db, message.account_id, target);
          if (!destination || message.mailbox !== destination.path) {
            // The user moved it somewhere else after the task ran; the newer
            // decision wins (legacy `:1097-1105`).
            settleUndoItem(deps.db, task.id, entry.id, "updated", report);
            continue;
          }
        }
        try {
          const client = await connections.clientFor(message.account_id);
          const outcome = await moveMessageToFolder(deps.db, deps.masterKey, entry.id, entry.fromMailbox, deps.accessTokenProvider, deps.agentMailEvents, { client });
          if (outcome.uncertain) {
            // The command was issued and the transport died before its answer, so
            // `moveMessageToFolder` does not throw at all: it preserves the intent and
            // hands the outcome to sync's reconciliation (`sync-moves.ts:504-511`).
            // Counting that `updated` would report a restore nobody can prove -- the
            // same unreadable row the guard at the top of this loop refuses to read
            // when *another* executor leaves it, and the reason that guard exists is
            // that `mailbox` is not evidence while a move is claimed (§4.7 A ④). So it
            // takes the same answer: wait. The socket goes first, because unlike the
            // four refusals below this failure *was* at the transport, so a corpse has
            // to be assumed; the retry then re-reads the row once the reconcile has
            // landed, and settles it either way.
            await connections.invalidate(message.account_id);
            refusal ??= new Error(PENDING_MOVE_RECONCILIATION_ERROR);
            continue;
          }
          settleUndoItem(deps.db, task.id, entry.id, "updated", report);
        } catch (error) {
          const text = error instanceof Error ? error.message : "";
          if (isRetryableUndoRefusal(text)) {
            // Nothing is latched and nothing is reported: the entry stays owed and
            // the next attempt finds it, which is what keeps the counters from
            // double-counting a message that will be restored on the retry. The
            // socket is deliberately kept -- all four retryable texts are decided by
            // local guards before any IMAP command, so this failure is evidence about
            // the account's state and none at all about the connection, and re-dialling
            // here would throw away the one connection the whole undo is built to share
            // (`batch-jobs.ts:150-156`, deleted -- that revision paid 27 minutes of
            // dialling). The `uncertain` outcome above is the exception that proves
            // the rule: it is decided by the transport, so there the socket is
            // dropped instead.
            refusal ??= error instanceof Error ? error : new Error(String(error));
            continue;
          }
          // A failure that did reach the provider -- or one raised after its answer.
          // The socket may be a corpse that still looks usable, so it is dropped:
          // without that, one dead connection fails every remaining entry instead of
          // only the one (`batch-jobs.ts:197-202`, deleted; the same reason).
          await connections.invalidate(message.account_id);
          // `failed` unless the goal holds *now*. A provider failure can be raised
          // after the message already got home by another path -- the user's own move
          // landing while this command was in flight, or the reconcile that put it
          // back -- and counting that `failed` would tell the user a message was not
          // restored while it sits at its origin. So the guard above is asked again on
          // fresher state: the same predicate, the same order (a claimed move owns
          // `mailbox`, §4.7 A ④), and the conservative answer when the row is gone. A
          // row that is home but still reads otherwise is counted `failed` on purpose:
          // "cannot be read" is not evidence that the restore happened, which is the
          // judgement the pre-guard's doc already makes for the claimed shape.
          const after = deps.db
            .prepare("SELECT mailbox, pending_move_state FROM messages WHERE id = ?")
            .get(entry.id) as { mailbox: string; pending_move_state: string | null } | undefined;
          const home = after !== undefined && after.pending_move_state === null && after.mailbox === entry.fromMailbox;
          settleUndoItem(deps.db, task.id, entry.id, home ? "updated" : "failed", report);
        }
      }
      if (refusal) throw refusal;
    } finally {
      await connections.release();
    }
  };
}
