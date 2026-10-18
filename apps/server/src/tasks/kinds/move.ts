import type { DatabaseHandle } from "../../db.js";
import { serverLog } from "../../logging.js";
import { accountById } from "../../account-store.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "../../mail.js";
import { safeLogout } from "../../imap-logout.js";
import { getSyncMessageLimit } from "../../settings.js";
import { syncAccount } from "../../sync.js";
import {
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  moveActionBlockedError,
} from "../../message-storage.js";
import { batchMoveMessages, resolveMoveDestination, type MessageMoveTarget } from "../../sync-moves.js";
import { moveStatements, type MoveDestination } from "../../sync-move-statements.js";
import type { AgentMailEventSink } from "../../agent/mail-state-events.js";
import { emitAccountSynced, type ServerEventBus } from "../../events.js";
import { memberTaskId } from "../job-ids.js";
import { TaskAbortError } from "../scheduler.js";
import { commitTask, reportTaskProgress, type CommitTaskDeps, type TaskHandle } from "../store.js";
import type { TaskItemSpec, TaskRow, TaskRunner } from "../types.js";

/**
 * The `move` kind: everything a move task knows, in both directions.
 *
 * The settlement surface is the port of `pendingMoveJobIds`/`revertMoveJobFailures`,
 * which the legacy `onOperationSettled` hook called when the queue gave up on a
 * `batch-move` row; the execution surface is the port of `runMoveJobRow` and the
 * three pieces of machinery around it. (Both live in the deleted `batch-jobs.ts` --
 * line numbers for it are only meaningful against a pre-batch-4 revision.) They
 * share one file because the undo runner will reuse this module's connection
 * session, and the contract's module list (§5) has no `move-session.ts` for it to
 * live in; the file's own layout is constants then read then settle then run. It is
 * not in `tasks/settlement.ts` because it needs the move mechanics: `moveStatements`
 * and `revertSourceFolderDeparture` (`sync-move-statements.ts`) are
 * `messages`/`folders` statements -- that file names no legacy table at all -- so
 * they are imported, not duplicated.
 *
 * Two things changed in the settlement port and nothing else did:
 *
 *   - `batch_job_messages` -> `task_items`, `job_id` -> `task_id`. The two tables
 *     are column-for-column the same (`batch-job-schema.ts`, also deleted, against
 *     `tasks/schema.ts:108`, primary key included), so the selection rows carry
 *     over unchanged, and `task_items` is an ordinary rowid table, so the
 *     `ORDER BY rowid` that makes chunking deterministic still means "the order
 *     the selection was written in".
 *   - the task is passed as the whole `TaskRow`, not as an id pair. That is
 *     deliberate, and it is the one thing about this port worth reading twice.
 *     The legacy helpers took the job id out of the executor's payload; a task's
 *     payload carries no id at all (`migrate.ts:408-428`), and a job that spans
 *     accounts gets one task per account whose id is `${jobId}:${accountId}`
 *     (`migrate.ts:529`) while a single-account job keeps the bare uuid. So "the
 *     id from the payload" resolves for a single-account job and matches nothing
 *     for a cross-account one -- and matching nothing here does not throw:
 *     `revertMoveFailures` returns 0 through its own empty-input short circuit,
 *     no log line is written, and the messages keep a `pending_move_destination`
 *     that makes the list projection hide them for good. Taking the row removes
 *     the argument that could be wrong.
 *
 * The execution half's one divergence from its legacy twin is the increment the
 * task layer asks for: `report` (contract §4.7 B2), which the old projection-based
 * progress had no need of.
 */

/** A message row as much of this file needs it: identity, origin, goal state. */
type MoveItemMessageRow = {
  id: string;
  account_id: string;
  mailbox: string;
  flags_json: string;
  /** Read by `moveActionBlockedError` below: an unverified location is one refusal. */
  remote_id_lookup: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

// SQLite compiles one statement with a bound variable per `?`, and the driver
// rejects a statement past its own parameter ceiling (measured: 32 766 ids
// succeed, 40 000 throw "too many SQL variables"). A predicate-scoped selection
// has no row cap -- the 5000-id cap covers explicit id lists, not "select all
// matching this view" -- so the failure revert must not put a whole selection
// into one IN (...) list: a 40 000-message move failed the entire job at 0% and
// echoed the raw SQL into the UI toast. 1000 keeps the statement far below any
// driver ceiling, and chunked lookups of 40 000 rows measured at 60ms.
//
// This is the *settle-time lookup* chunk, not a dispatch batch size: the number
// is bounded by the parameter ceiling, and whatever chunk a runner sends MOVE
// commands in answers a different question.
const ORIGIN_LOOKUP_CHUNK_SIZE = 1000;

/**
 * Ids a move task still owes the provider, in selection order.
 *
 * Reached by the goal columns rather than by a stored list, so it is also what
 * makes a retry resume instead of replay. A row falls out for one of four
 * reasons, and the state behind each one is worth knowing before editing the
 * query:
 *
 *   - `changed = 0` -- the job never touched this message.
 *   - `failed = 1` -- the one-time give-up latch, written by whichever path gave
 *     the goal back first.
 *   - `pending_move_state IS NOT NULL` -- claimed. `intent` is a MOVE command in
 *     flight (or one whose response was lost, which sync's reconcile owns);
 *     `confirmed` is the reconcile's own arrival, which keeps the goal and sets
 *     the state instead of clearing it (`RECONCILE_CONFIRM_SQL`,
 *     `sync-move-statements.ts:197`).
 *   - `pending_move_destination` NULL or pointing somewhere else -- the goal is
 *     gone. Three writers do that: a UIDPLUS arrival, in the same statement that
 *     rewrites the mailbox (`UIDPLUS_CONFIRM_SQL`, `sync-move-statements.ts:177`),
 *     the give-up path giving the goal back, and the user re-moving the message
 *     onto a newer destination.
 *
 * So there is deliberately no mailbox comparison: arrival is not a separate fact
 * to test for, it is *why* the goal is gone. Adding one would be redundant in the
 * UIDPLUS case and wrong in the reconcile case, where the mailbox column still
 * reads the source.
 *
 * One predicate here is not one of the four: `b.destination_mailbox IS NOT NULL`.
 * It cannot change the result set -- the goal clause compares the two columns for
 * equality, and `X = NULL` is never true -- and it is kept only because the legacy
 * statement has it and it states the intent. A reader looking for the test that
 * pins it will not find one, because deleting it is unobservable.
 */
export function pendingMoveItemIds(db: DatabaseHandle, task: TaskRow): string[] {
  return db
    .prepare(`
      SELECT m.id FROM task_items AS b
      JOIN messages AS m ON m.id = b.message_id
      WHERE b.task_id = ? AND b.changed = 1 AND b.failed = 0
        AND m.account_id = ?
        AND m.pending_move_state IS NULL
        AND b.destination_mailbox IS NOT NULL
        AND m.pending_move_destination = b.destination_mailbox
      ORDER BY b.rowid
    `)
    .pluck()
    .all(task.id, task.account_id) as string[];
}

/** What one call to {@link revertMoveFailures} did. */
export type RevertedMoveFailures = {
  /** How many refused ids were confirmed never to have reached the destination. */
  reverted: number;
  /** How many selection rows this call latched, i.e. how many ids the task stops owing. */
  latched: number;
};

/**
 * Puts back what a move task could not deliver: the acceptance-time goal of each
 * refused id.
 *
 * The `failed` mark in `task_items` is the one-time latch -- a row that already
 * carries it is done, whichever path got here first (the runner reporting a
 * provider refusal, or the scheduler giving up on the whole task).
 *
 * The source-folder count this used to hand back is gone with the count columns
 * (contract §3.6): `messages` is the only record of where a row is, and clearing
 * the goal is what puts it back. `reverted` survives as the narrower fact the
 * callers and their tests read off it -- how many of the refused ids never
 * reached the destination -- because "never arrived" and "the task stopped owing
 * this id" remain different questions, and it is `latched` that the runner
 * reports as the task's failure count, precisely so a row already accounted for
 * cannot be counted twice.
 */
export function revertMoveFailures(db: DatabaseHandle, task: TaskRow, ids: readonly string[]): RevertedMoveFailures {
  if (ids.length === 0) return { reverted: 0, latched: 0 };
  const statements = moveStatements(db);
  const taskId = task.id;
  return db.transaction(() => {
    let reverted = 0;
    let latched = 0;
    for (let offset = 0; offset < ids.length; offset += ORIGIN_LOOKUP_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ORIGIN_LOOKUP_CHUNK_SIZE);
      const rows = statements.rowsByIds(chunk.length).all(...chunk) as MoveItemMessageRow[];
      const messageById = new Map(rows.map((row) => [row.id, row]));
      const marked = db.prepare(`
        SELECT message_id, destination_mailbox FROM task_items
        WHERE task_id = ? AND changed = 1 AND failed = 0
          AND message_id IN (${chunk.map(() => "?").join(", ")})
      `).all(taskId, ...chunk) as Array<{ message_id: string; destination_mailbox: string | null }>;
      const claim = db.prepare("UPDATE task_items SET failed = 1 WHERE task_id = ? AND message_id = ? AND changed = 1 AND failed = 0");
      for (const entry of marked) {
        const message = messageById.get(entry.message_id);
        if (!message) {
          // The message is gone from the cache; there is no goal to clear and no
          // counter to give back, but the selection must stop claiming it. Only
          // reachable for a message deleted after the acceptance commit -- a
          // migrated selection row has already outlived the messages that no
          // longer exist, because a row whose message cannot be resolved is not
          // carried over at all.
          claim.run(taskId, entry.message_id);
          latched += 1;
          continue;
        }
        // The goal clear is a no-op when the runner already consumed it (an
        // intent it cleared on refusal), and that is now the whole action: there
        // is no counter to give back, and clearing the goal is what returns the
        // row to its source folder.
        statements.clearMoveGoal.run(entry.message_id, entry.destination_mailbox);
        if (neverArrived(message, entry.destination_mailbox)) {
          reverted += 1;
        }
        claim.run(taskId, entry.message_id);
        latched += 1;
      }
    }
    return { reverted, latched };
  })();
}

/**
 * Whether a message the task could not deliver is still sitting where it started.
 *
 * Four ways to answer "no", and the two claimed-state ones are the interesting
 * pair. An in-flight `intent` is ambiguous -- the command may have landed -- and
 * sync owns it. A `confirmed` row is that same judgement already made: the
 * reconcile proved the message reached the destination, so reading it as a
 * never-arrived id was wrong even back when there was a source count to hand back
 * (that count, `updateFolderCountsForMove`, is deleted with the counts in
 * contract §3.6). The legacy predicate (`batch-jobs.ts:937`, deleted) has no
 * `confirmed` clause, and that is the one deliberate divergence in this port:
 * the contract's §4.7 (v14) records why, and the interleaving that reaches it --
 * one executor's claim failing against another executor's confirmed row, which
 * lands the id in
 * `failures` as a non-retryable refusal. Reading *any* claimed state as "sync owns
 * it" is also what makes this the exact mirror of the read's
 * `pending_move_state IS NULL`.
 *
 * The remaining two are the mirror image of the projection's "arrived" test: a
 * mailbox that already reads the destination means the arrival was UIDPLUS's, and
 * a goal pointing somewhere else is a newer user decision.
 */
function neverArrived(message: MoveItemMessageRow, destinationMailbox: string | null): boolean {
  if (!destinationMailbox) return false;
  if (message.mailbox === destinationMailbox) return false;
  if (message.pending_move_state !== null) return false;
  if (message.pending_move_destination && message.pending_move_destination !== destinationMailbox) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The acceptance half: the local target state a user's move commits, and the
// tasks that will converge it.
//
// The port of `acceptMoveJob` (`batch-jobs.ts:631-753`, deleted), which only the
// batch-job entry could reach. All three entries reach it now -- the single
// `/api/messages/:id/move`, the explicit `POST /api/messages/batch/move` and a
// `POST /api/batch-jobs` of kind move (contract §九 D3) -- so the classification
// below is the union of the three paths' local guards read from the source, and
// the batch job's `{ ok, jobId }` answer is derived from the tasks this
// commits rather than from a job row of its own (`GET /api/batch-jobs/:id`
// aggregates by id prefix, §九 D4).
// ---------------------------------------------------------------------------

/**
 * Why an acceptance could not touch one id.
 *
 * Four of the five are the legacy refusals kept apart rather than collapsed into
 * a count, because the three entries answer their callers in different words for
 * them: the single route throws the message, the explicit batch route returns
 * one per id. The task layer carries the reason and no text -- the wording is
 * the routes' business, and the two blocked reasons are the two distinct strings
 * `moveActionBlockedError` already ships.
 */
export type MoveRefusalReason =
  /** No `messages` row for the id: the cache never had it, or it was deleted since. */
  | "not_found"
  /** The account has no folder for the target (`resolveMoveDestination` resolved none). */
  | "unavailable"
  /** Another move owns the row: a goal or a claim is on it (`moveActionBlockedError`). */
  | "reconciling"
  /** The same, for a confirmed arrival the provider gave no stable remote id for. */
  | "location_unverified"
  /** The row changed between the read and the transaction: a concurrent claim took it. */
  | "claimed";

export type MoveRefusal = { id: string; reason: MoveRefusalReason };

export type AcceptMoveInput = {
  target: MessageMoveTarget;
  messageIds: readonly string[];
  /**
   * Caller-chosen job id, for the batch-job entry only.
   *
   * `GET /api/batch-jobs/:id` resolves a user-visible job by the id prefix its
   * tasks share, so a job has to name them. Omitted -- the single and the
   * explicit batch entries, which answer from this call's return value -- the
   * tasks get fresh UUIDs and no job can be polled for them.
   */
  jobId?: string;
  /**
   * The undo window every task this commits opens, or absent for a move that
   * offers none. One window for one user action, not one per account slice:
   * a single move and an explicit batch move offer none, a batch job passes its
   * own (`TASK_UNDO_WINDOW_MS`, which is the legacy `BATCH_JOB_UNDO_WINDOW_MS`).
   */
  undoWindowMs?: number;
};

export type MoveTaskAcceptance = {
  /**
   * One handle per committed task -- one per account in the selection. All the
   * rows are created inside the acceptance's transaction; `start()` joins each to
   * its account's chain and is called after the commit.
   */
  handles: TaskHandle[];
  /** The id the tasks were named after, when the caller named one. */
  jobId: string | null;
  /** Ids whose goal is now in force: the ones moved plus the ones already there. */
  updated: number;
  /**
   * How many of `updated` the tasks must still deliver: `updated - delivering`
   * were already at the destination.
   *
   * The single route's `refreshPending` is exactly "is there anything left to
   * come for this message", and it needs this count rather than `handles.length`
   * because a slice that is entirely settled -- or entirely refused -- still
   * commits a task: the row is what carries the slice's `total`, and one task per
   * account slice is the shape every entry shares. `moveMessage` answered the
   * same question with `false` for an arrived message (`sync-moves.ts:195-201`),
   * so reading the goal count here rather than the task count is what keeps the
   * route's answer to that case unchanged (contract §0.4 十五 W2).
   *
   * Counted in the classification, not re-derived later: the goal write is the
   * same fact ("this id is being sent"), and a second read of the row would both
   * duplicate it and race the one this acceptance already took.
   */
  delivering: number;
  /** Ids the acceptance could not touch, in input order. */
  refusals: MoveRefusal[];
  /** accountId -> the folder path that account's move is headed for. */
  destinations: Map<string, string>;
};

/** One account's slice of an acceptance, as the transaction needs it. */
type MoveAccountPlan = {
  /** Resolved before the transaction; null only for an account with no target folder. */
  destination: MoveDestination | null;
  /** The slice's selection rows, input order. `changed` is cleared for a claim that fails. */
  items: TaskItemSpec[];
  /** The rows this transaction will try to claim a goal on, with their selection rows. */
  movable: Array<{ message: MoveItemMessageRow; item: TaskItemSpec }>;
  /** Already at the destination: no goal, no work, and a success. */
  settled: number;
  /** Refused before the transaction: no folder, or owned by another move. */
  refused: number;
};

/**
 * Accepts a move: writes each message's goal and the source-folder departure in
 * one transaction with one durable task per account, then starts them.
 *
 * What the acceptance deliberately does not do is talk to the provider. The
 * messages leave their source view the moment the user confirms, and the tasks
 * deliver them; that is what makes a bulk delete of 40 000 messages answer
 * immediately instead of after 400 MOVE commands, and it is the whole point of
 * the local-first shape `acceptMoveJob` already had.
 *
 * The classification of one id is the batch acceptance's order, and the two
 * differences from the single-move path are worth stating because the single
 * route now goes through here:
 *
 *   - "already at the destination" is checked **before** the blocked test, so an
 *     arrived message counts as done even when the row still carries a goal or a
 *     confirmed state. `moveMessage` tests the other way round
 *     (`sync-moves.ts:189-199`), which turns a duplicate archive of an arrived
 *     message into an error; the batch path has always answered it as the no-op
 *     it is (`batch-jobs.ts:676`, deleted), and the goal is satisfied either way.
 *   - A stale `intent` whose source UID is still live is **not** recoverable
 *     here. `moveMessage` re-probes the source mailbox over IMAP to decide
 *     whether the interrupted MOVE ever executed (`sync-moves.ts:143`), and an
 *     acceptance cannot: it makes no provider call. Such a row is refused as
 *     `reconciling` and sync's reconcile owns it (I5), after which the move can
 *     be issued again. Contract §九 D5 records both.
 */
export function acceptMoveTask(deps: CommitTaskDeps, input: AcceptMoveInput): MoveTaskAcceptance {
  // The root a batch job names its tasks after has to be a non-empty colon-free
  // string: the alias finds a job's members by splitting an id at the first colon
  // (`jobs.ts`'s `rootJobId`), and `""` is a prefix of every id. A root that carried
  // a colon would make its own members indistinguishable from another job's -- the
  // grammar is positional, so nothing downstream can separate the two readings --
  // and this is the last place that knows which string is the root, so it is refused
  // here, before any row exists. No caller reaches it by accident:
  // `/api/batch-jobs` takes no job id from the wire (`schemas.ts:168-179` is
  // `.strict()`; the route mints the UUID itself, `routes/batch-jobs.ts:71`), and
  // the other two entries omit it.
  if (input.jobId !== undefined && (input.jobId === "" || input.jobId.includes(":"))) {
    throw new Error(`A batch job id must be a non-empty colon-free string (got "${input.jobId}").`);
  }
  // Deduplicated up front, so `total` counts exactly the rows `task_items` will
  // hold. `insertTaskItems` is INSERT OR IGNORE -- a repeated id in a selection
  // (the global-search join can repeat a message) lands once -- and a `total`
  // that counted it twice could never be reached, which is the arithmetic the
  // batch-job alias reports to the renderer.
  const ids = [...new Set(input.messageIds)];
  if (!ids.length) return { handles: [], jobId: null, updated: 0, delivering: 0, refusals: [], destinations: new Map() };

  const now = Date.now();
  const statements = moveStatements(deps.db);
  // Read in chunks: a 40 000-id selection in one IN list exceeds the driver's
  // variable ceiling (see ORIGIN_LOOKUP_CHUNK_SIZE). Merging the chunks keeps
  // single-IN semantics -- one entry per id, and an id a join repeated still
  // resolves to the one row it names.
  const rowsById = new Map<string, MoveItemMessageRow>();
  for (let offset = 0; offset < ids.length; offset += ORIGIN_LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + ORIGIN_LOOKUP_CHUNK_SIZE);
    const rows = statements.rowsByIds(chunk.length).all(...chunk) as MoveItemMessageRow[];
    for (const row of rows) rowsById.set(row.id, row);
  }

  // One destination resolution per account, outside the transaction: it reads
  // `folders`, and it throws for an account without a folder for the target.
  const resolved = new Map<string, MoveDestination | null>();
  const destinationFor = (accountId: string): MoveDestination | null => {
    if (!resolved.has(accountId)) {
      let destination: MoveDestination | null = null;
      try {
        destination = resolveMoveDestination(deps.db, accountId, input.target);
      } catch {
        // An account without a target folder (or one mid-teardown) cannot take
        // this move; its messages are refused rather than queued forever.
        destination = null;
      }
      resolved.set(accountId, destination);
    }
    return resolved.get(accountId) ?? null;
  };

  const reasons = new Map<string, MoveRefusalReason>();
  const byAccount = new Map<string, MoveAccountPlan>();
  for (const id of ids) {
    const message = rowsById.get(id);
    if (!message) {
      // Unattributable, and that is the one refusal with a consequence beyond
      // its own row: `total` is per task, so an id no account can own is in no
      // task's total either. The callers that answer directly report it; a job's
      // progress simply does not count it (contract §九 D6).
      reasons.set(id, "not_found");
      continue;
    }
    let plan = byAccount.get(message.account_id);
    if (!plan) {
      plan = { destination: destinationFor(message.account_id), items: [], movable: [], settled: 0, refused: 0 };
      byAccount.set(message.account_id, plan);
    }
    const destination = plan.destination;
    if (!destination) {
      plan.refused += 1;
      plan.items.push({ messageId: id, changed: false, originMailbox: message.mailbox, destinationMailbox: null });
      reasons.set(id, "unavailable");
      continue;
    }
    if (message.mailbox === destination.path) {
      // Already where the move would put it. Counted as done and given no goal:
      // a goal here would be a promise nothing would ever resolve.
      plan.settled += 1;
      plan.items.push({ messageId: id, changed: false, originMailbox: message.mailbox, destinationMailbox: destination.path });
      continue;
    }
    const blocked = moveActionBlockedError(message);
    if (blocked) {
      plan.refused += 1;
      plan.items.push({ messageId: id, changed: false, originMailbox: message.mailbox, destinationMailbox: destination.path });
      reasons.set(id, blocked === MOVE_LOCATION_UNVERIFIED_ERROR ? "location_unverified" : "reconciling");
      continue;
    }
    const item: TaskItemSpec = { messageId: id, changed: true, originMailbox: message.mailbox, destinationMailbox: destination.path };
    plan.items.push(item);
    plan.movable.push({ message, item });
  }

  const accounts = [...byAccount.keys()];
  const accepted = deps.db.transaction(() => {
    const handles: TaskHandle[] = [];
    // Ids whose goal this transaction actually wrote -- the ones with something
    // left to deliver. Counted here rather than as `movable.length`: the goal
    // guard below is what decides, and an id a concurrent claim took is refused.
    let delivering = 0;
    for (const accountId of accounts) {
      const plan = byAccount.get(accountId)!;
      // Null only for an account with no target folder, which by construction has
      // nothing movable -- every id of its slice is already refused.
      const destination = plan.destination;
      let refused = plan.refused;
      // Claim the goals. A row whose guard now fails was claimed between the read
      // above and this transaction -- a concurrent move, or this account's own
      // executor taking an earlier task's goal -- and is refused rather than
      // queued, exactly as `acceptMoveJob` answers its `changes !== 1` case. The
      // selection row stays, with `changed` cleared: it is part of what the user
      // asked for and of this task's `total`, and there is no goal on it to clear.
      if (destination) for (const { message, item } of plan.movable) {
        const wroteGoal = statements.beginMoveGoal.run(destination.path, destination.special_use, message.id);
        if (wroteGoal.changes !== 1) {
          refused += 1;
          item.changed = false;
          reasons.set(message.id, "claimed");
          continue;
        }
        // The message leaves its SOURCE folder now -- writing the goal is what
        // does it, through the effective-mailbox generated column. Nothing counts
        // the departure and nothing will count the arrival: every number the UI
        // shows is derived from `messages` (contract §3.6).
        delivering += 1;
      }
      const jobId = input.jobId;
      const id = jobId === undefined
        // `memberTaskId` owns the grammar and the alias is the reader: the bare id
        // when the job is this one member, `jobId:accountId` when it spans
        // accounts, because the alias groups rows by prefix. The bare id for a
        // multi-account job would make the alias resolve one account and silently
        // drop the others. A move commits one member per account, so this is
        // always that account's first (and only) slice.
        ? undefined
        : memberTaskId(jobId, accountId, 1, accounts.length);
      const handle = commitTask(deps, {
        ...(id === undefined ? {} : { id }),
        accountId,
        kind: "move",
        scope: ids.length > 1 ? "batch" : "single",
        // The slice is this task's account, and `total` counts every id of the
        // selection that has a row on it -- the refused and the already-arrived
        // ones included, because they are what the user asked for and what the
        // job's progress has to add up to. A row with a goal is left at 0/0 for
        // its runner to report.
        total: plan.items.length,
        undoWindowMs: input.undoWindowMs,
        items: plan.items,
        payload: { target: input.target },
        now,
      });
      // The opening counters, written in the acceptance's own transaction. Only
      // the ids that can never be delivered are settled here, so `updated +
      // failed` reaches `total` exactly once per id: the sets are disjoint by
      // construction, because the runner reads `changed = 1` and this counts the
      // rows that are not. Deferring it to the caller would leave a window in
      // which a poller reads 0/0 for a job the acceptance already knows failed.
      reportTaskProgress(deps.db, handle.id, { updated: plan.settled, failed: refused }, now);
      handles.push(handle);
    }
    return { handles, delivering };
  })();
  // The FIFO chain starts only after the commit: a starter that ran inside the
  // transaction would dispatch work a rollback had already erased.
  for (const handle of accepted.handles) handle.start();

  return {
    handles: accepted.handles,
    jobId: input.jobId ?? null,
    // Every id is refused, already there, or moving -- so this needs no counter
    // of its own, and cannot drift from the refusals the callers report.
    updated: ids.length - reasons.size,
    delivering: accepted.delivering,
    refusals: ids.filter((id) => reasons.has(id)).map((id) => ({ id, reason: reasons.get(id)! })),
    destinations: new Map(
      [...byAccount]
        .filter((entry): entry is [string, MoveAccountPlan & { destination: MoveDestination }] => entry[1].destination !== null)
        .map(([accountId, plan]) => [accountId, plan.destination.path]),
    ),
  };
}

// ---------------------------------------------------------------------------
// The execution half: what a move task sends to the provider, and what it
// reports back. The port of the machinery around `runMoveJobRow`
// (`batch-jobs.ts:139/164/808/833`, deleted), with one deliberate change of
// shape -- the report and the give-back are per chunk, the background reconcile
// is per attempt, for the reasons spelled out on `createMoveRunner`.
// ---------------------------------------------------------------------------

/**
 * Ids per MOVE command: one command per (account, source mailbox) group per
 * chunk, issued on the connection the task holds for its whole run (see
 * {@link createMoveConnections}).
 *
 * The size is not decorative. A chunk boundary used to cost a connect/logout
 * round trip, and 40 000 ids at 100 per chunk is 400 of them at ~4s each on
 * Gmail -- 27 minutes of pure connection setup, which is what sharing the
 * connection removed. What the size still buys is unrelated to the 100-id cap of
 * the HTTP batch move API (this call is in-process and not bound by it): it
 * bounds how many messages one refused or lost MOVE command can fail at once, it
 * keeps the account write slot held briefly so a long task does not starve
 * concurrent user writes behind it, and it keeps the progress counter advancing
 * every 100 messages.
 */
const MOVE_CHUNK_SIZE = 100;

/**
 * A "wait your turn" refusal: the account was syncing or already moving, so the
 * message's goal must survive and the task must be retried. Kept as the exact
 * texts `batchMoveMessages` reports them under -- the failure list carries
 * messages, not error objects, and these two are pushed through verbatim (see
 * `knownLocalMoveErrors`, which keeps the translator from flattening them into
 * the generic provider error; flattening them is what would make a bulk move give
 * its goals back instead of retrying them).
 *
 * Membership is what routes a refusal between the two give-up paths, so what is
 * *not* in the set is as load-bearing as what is.
 * `PENDING_MOVE_RECONCILIATION_ERROR` (sync, or a second executor, already owns
 * this row's outcome) is a real loss to this task -- there is nothing left for it
 * to send -- so it belongs in the revert path, and the revert is safe for it
 * precisely because `neverArrived` reads any claimed state as "sync owns the
 * outcome" (contract §4.7 v14).
 */
const RETRYABLE_MOVE_FAILURES = new Set([MAILBOX_SYNCING_ERROR, MAIL_MOVE_IN_FLIGHT_ERROR]);

/**
 * Whether a refusal means "wait your turn" rather than "this message is lost".
 *
 * The undo runner builds its own superset on top of this one (§4.7 A ④): the two
 * texts that end a move task's attempt are the two that must not end an undo's.
 */
export function isMoveWaitRefusal(message: string): boolean {
  return RETRYABLE_MOVE_FAILURES.has(message);
}

type MoveImapClient = Awaited<ReturnType<typeof imapClientForAccount>>;
/**
 * The IMAP connections a task holds, one per account, and the one place that
 * decides when each is hung up or replaced.
 *
 * `batchMoveMessages` owns a connection for the duration of one call and hangs up
 * before returning, which is right for a single HTTP request and ruinous for a
 * background task: a 40 000-message selection is 400 such calls, so the per-call
 * lifecycle meant 400 round trips for one move. A task is the only caller that
 * issues many batches in a row, so the task is what owns the socket: one live
 * connection per account, hung up in the runner's `finally` whether it finished
 * or threw.
 *
 * `cache` is handed to each `batchMoveMessages` call, whose own get-or-dial block
 * then finds the connection already there; nothing about that block changed. That
 * block is also why the move runner never replaces a corpse: a client it cannot
 * use, or one whose command throws, it drops and re-dials itself.
 *
 * `clientFor`/`invalidate` are the other half, and they exist for the undo
 * (`kinds/undo.ts`), the one path that moves message by message on a cached client
 * and must therefore drop a dead socket explicitly -- a socket that died mid-command
 * can still look usable for a moment, and without `invalidate` one dead connection
 * fails every remaining entry instead of only the one. Both shapes are one session
 * because the socket lifecycle is one decision (get-or-dial, drop the corpse before
 * dialling, log out in `release`), and the legacy kept them in one function for the
 * same reason (`createJobMoveConnections`, `batch-jobs.ts:164-212`, both deleted).
 */
export function createAccountConnections(db: DatabaseHandle, masterKey: Buffer, accessTokenProvider?: AccountAccessTokenProvider) {
  const clients = new Map<string, MoveImapClient>();
  return {
    /** The connection cache `batchMoveMessages` reads and fills. */
    cache: clients,
    /**
     * The account's live client: dialled on first use, and re-dialled once the
     * cached one is no longer usable (a connection that outlived its idle
     * timeout must not be handed to the next message).
     */
    async clientFor(accountId: string): Promise<MoveImapClient> {
      const cached = clients.get(accountId);
      if (cached?.usable) return cached;
      const account = accountById(db, accountId);
      if (!account) throw new Error("Account not found.");
      if (cached) await cached.logout().catch(() => undefined);
      // Drop the corpse before dialling: a connect() that throws would
      // otherwise leave a connection known to be dead in the cache, and every
      // remaining entry would be handed it.
      clients.delete(accountId);
      const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
      await client.connect();
      clients.set(accountId, client);
      return client;
    },
    /** Drops the account's connection so the next entry dials a fresh one. */
    async invalidate(accountId: string): Promise<void> {
      const cached = clients.get(accountId);
      if (!cached) return;
      clients.delete(accountId);
      await safeLogout(cached);
    },
    /** Hangs up every connection the task opened. */
    async release(): Promise<void> {
      const open = [...clients.values()];
      clients.clear();
      for (const client of open) await safeLogout(client);
    },
  };
}

/** What a move task's sealed payload carries. `migrate.ts:409-411` rebuilds it
 * from a legacy job's `target`. */
export type MoveTaskPayload = { target: MessageMoveTarget };

/**
 * What the runner needs from the built app.
 *
 * The account write slot is deliberately absent: the scheduler acquires it before
 * calling the runner, and a runner that took it again would be a second,
 * uncoordinated way to say the same thing.
 */
export type MoveRunnerDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  accessTokenProvider?: AccountAccessTokenProvider;
  agentMailEvents?: AgentMailEventSink;
  /**
   * Where the reconcile kick's `mail.synced` goes.
   *
   * The move routes used to publish this themselves, right after their own
   * `syncAccount` call; the runner owns the reconcile now, so it owns the event
   * too. Without it the renderer's move confirmation never runs: `realtimeSync`
   * maps `mail.synced` to its refresh, and `pendingArchiveMoves` is resolved by
   * that refresh and nothing else (`events.ts` names "move reconciliation" as one
   * of the senders for exactly this reason). Optional like the other build-time
   * seams, so the runner's own tests can drive it without an app.
   */
  serverEvents?: ServerEventBus;
  /**
   * The app's shutdown signal, handed to the reconcile pass.
   *
   * `syncAccount`'s signal is positional and optional, and what it means here is
   * narrow but load-bearing: process shutdown aborts this reconciliation, while
   * the client that issued the move navigating away must not -- the goal is
   * already committed and the reconcile is the only thing that will ever verify
   * it. `route-sync-shutdown.test.ts` pins the distinction for the route that
   * used to pass it.
   */
  syncAbortSignal?: AbortSignal;
};

/**
 * Delivers one account's worth of a move task: every chunk of ids the task still
 * owes, on one connection, settling each chunk as it goes.
 *
 * A refusal the provider is unlikely to repeat (a bad message, a missing folder)
 * gives its goal back immediately: the message reappears in its source view and
 * the task counts it failed, instead of staying hidden behind a promise nobody
 * will keep. A "wait your turn" refusal is the opposite -- reverting it would only
 * make the list flicker and the goal come right back -- so those keep their goals
 * and fail the attempt, and the scheduler retries it with backoff.
 *
 * Per-chunk settlement is the one deliberate difference from the legacy executor.
 * Its progress was a projection over the selection, so "which attempt reported
 * this" did not exist; a task's counters are written by its runner instead, and
 * anything settled only at the end of the loop would be lost the moment a later
 * chunk threw -- the ids already delivered have had their goals cleared, so no
 * retry can see them again and nothing could ever repair the count. Two smaller
 * consequences of the same shape: a refusal's message comes back to its source
 * view after one chunk rather than after an account's worth of them, and the
 * first chunk that reports a "wait your turn" refusal ends the attempt instead of
 * spending the remaining chunks on commands an account-level guard will refuse
 * identically (both texts come from account-level conditions -- `isAccountMoving`,
 * `isAccountSyncing` -- and every id of this task is on `task.account_id`). That
 * costs nothing: those ids keep their goals, so the retry finds them, and only
 * them.
 *
 * The reconcile kick goes the other way -- one per attempt, from the `finally`
 * after the last chunk -- and that placement is load-bearing rather than
 * inherited. `syncAccount` claims the account for the length of its whole pass,
 * and a chunk that starts while that pass is live waits on it (`isAccountSyncing`
 * -> `waitForAccountSyncIdle`, `sync-moves.ts:572`) for at most
 * `ACCOUNT_SYNC_WAIT_MS`; a pass over a real mailbox outlives that, so a kick
 * issued after chunk N would refuse chunk N+1 with `MAILBOX_SYNCING_ERROR` -- this
 * task's own reconcile turned into this task's retryable failure, and turned into
 * a retry that has to wait out the same pass. It would happen precisely on the
 * accounts that ever produce `pendingAccounts` (no UIDPLUS, or a response that
 * never arrived), which is also where a bulk move is already the slowest. The
 * `finally` is what keeps the kick unskippable: a chunk that throws still has to
 * start the reconcile for the accounts earlier chunks left ambiguous, because
 * those ids are claimed and therefore out of every retry's read -- this kick is
 * the only thing that will ever ask for their reconcile.
 */
export function createMoveRunner(deps: MoveRunnerDeps): TaskRunner<MoveTaskPayload> {
  return async ({ task, payload, report }) => {
    if (!payload?.target) {
      // Not a retryable failure: a payload that is missing or unreadable now will
      // be just as missing on the eighth attempt, and the backoff rounds in
      // between are pure delay. Settling `failed` also fires the
      // permanent-failure hook, which is what hands the selection back.
      throw new TaskAbortError("failed", "Move task carries no destination.", "no_payload");
    }
    // Read, not carried: these are the ids the task still owes, so an attempt
    // resumes instead of replaying, and a row that moved on in between (delivered,
    // claimed, re-goaled, latched) is simply not in the list.
    const ids = pendingMoveItemIds(deps.db, task);
    if (ids.length === 0) return;
    const connections = createAccountConnections(deps.db, deps.masterKey, deps.accessTokenProvider);
    // The provider could not confirm these accounts' MOVE outcomes (no UIDPLUS, or
    // a response that never arrived). Collected as the chunks run and kicked once,
    // after the loop: starting a pass any earlier would block this task's own next
    // chunk (see the doc comment above).
    const pendingAccounts = new Set<string>();
    try {
      for (let offset = 0; offset < ids.length; offset += MOVE_CHUNK_SIZE) {
        const chunk = await batchMoveMessages(
          deps.db,
          deps.masterKey,
          ids.slice(offset, offset + MOVE_CHUNK_SIZE),
          payload.target,
          deps.accessTokenProvider,
          deps.agentMailEvents,
          connections.cache,
        );
        for (const accountId of chunk.pendingAccounts) pendingAccounts.add(accountId);
        const waiting = chunk.failures.filter((failure) => RETRYABLE_MOVE_FAILURES.has(failure.message));
        const { latched } = revertMoveFailures(
          deps.db,
          task,
          chunk.failures.filter((failure) => !RETRYABLE_MOVE_FAILURES.has(failure.message)).map((failure) => failure.id),
        );
        // `latched`, not the length of the list handed to the revert: those are
        // two different quantities (see `revertMoveFailures`), and this one is
        // "how many ids this task has stopped owing". The waiting ids are
        // deliberately not reported as failed -- they have not settled, and
        // whichever attempt settles them reports them.
        report({ updated: chunk.updated, failed: latched });
        // Throwing is what makes the scheduler keep the row and retry it with
        // backoff; it must come after the revert and the report, or the ids this
        // chunk just gave back are handed back again by the retry.
        if (waiting.length > 0) throw new Error(waiting[0]!.message);
      }
    } finally {
      // Before the connection is handed back, and on every exit path including
      // the throw above: those messages are already counted as delivered, and
      // reconciling in the background is what makes the cache agree with the
      // provider instead of leaving a local snapshot nobody verified. The kick
      // cannot be skipped by the throw -- the ids it reconciles are claimed, so
      // no retry reads them and nothing else will ever ask for this pass.
      for (const accountId of pendingAccounts) {
        void syncAccount(
          deps.db,
          deps.masterKey,
          accountId,
          getSyncMessageLimit(deps.db),
          deps.accessTokenProvider,
          deps.agentMailEvents,
          deps.syncAbortSignal,
        )
          .then(() => emitAccountSynced(deps.db, deps.serverEvents, accountId))
          .catch((error) => {
            serverLog.warn({ taskId: task.id, accountId }, "Background move reconciliation failed", error);
          });
      }
      await connections.release();
    }
  };
}
