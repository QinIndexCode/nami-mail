import type { DatabaseHandle } from "../../db.js";
import { preparedStatement } from "../../db.js";
import type { AccountAccessTokenProvider } from "../../mail.js";
import type { AgentMailEventSink } from "../../agent/mail-state-events.js";
import {
  flagsPushError,
  prepareLocalFlags,
  pushFlagsRemote,
  type FlagsPushEntry,
  type PreparedFlagsChange,
} from "../../flags-outbox.js";
import type { MessageFlagsPatch } from "../../message-flags.js";
import type { ServerEventBus } from "../../events.js";
import { kickAccountSync } from "../kick-sync.js";
import { memberTaskId } from "../job-ids.js";
import { TaskAbortError } from "../scheduler.js";
import { commitTask, type CommitTaskDeps, type TaskHandle } from "../store.js";
import type { TaskRunner } from "../types.js";

/**
 * The `flags` kind: the local-first flag commit, and the two payload spellings
 * its runner has to serve (contract §4.7 B/B3).
 *
 * Why two. The migration copies a legacy queue row's `payload_json` verbatim into
 * `payload_ciphertext` (`migrate.ts:352-356`, unsealed until the seal pass), and
 * `QueuePlan` has no payload field at all (`migrate.ts:255-258`) -- so the spelling
 * that arrives is whatever the writing build used. For `kind='flags'` that is
 * `{accountId, entries}` (the `flags-push` spelling, which `505f5f3` really did
 * stage in 0.3.0) or `{patch}` (job-derived rows, `migrate.ts`'s `planJob`).
 * `tests/task-migration.test.ts:780-830` pins that both survive the migration, so
 * both are this runner's problem.
 *
 * The acceptance is the port of the deleted `acceptFlagsJob` (`batch-jobs.ts`
 * :356-404 -- line numbers into that file, here and below, only mean anything
 * against a pre-batch-4 revision) with the task layer's one addition: the local
 * target state and the durable task that converges it commit as one. What it does
 * NOT do is reuse the also-deleted `applyPreparedFlagsInTransaction`: that
 * function's whole remaining job was staging `flags-push` rows into the
 * `operation_queue`, which is exactly the object `commitTask` replaces. The write
 * statements below are its first loop, statement for statement; the durable half is
 * `commitTask`, and the `changed = 1` marker half is `task_items`.
 */

/**
 * Entries per task, ported from `FLAGS_PUSH_ROW_ENTRY_LIMIT` (the deleted
 * `batch-jobs.ts:124`) for the same reason it existed there: a predicate selection
 * is unbounded, and one task carrying tens of thousands of entries would be one
 * enormous STORE command and one enormous payload for every later settlement scan.
 */
const FLAGS_TASK_ENTRY_LIMIT = 1000;

/**
 * The spelling this layer writes: the flag delta frozen at commit time, one entry
 * per message that actually changed, split across accounts and slices.
 *
 * `accountId` is duplicated from the row's own `account_id` because this is the
 * legacy `flags-push` payload shape (`flags-outbox.ts`'s `FlagsPushEntry`, `:129`)
 * and readers of the payload should not have to know which spelling they hold. The
 * runner pushes
 * `task.account_id`, not this field: the row is the authority, and a payload field
 * that disagrees with it is a bug this makes unobservable (the same lesson the
 * move port learned about job ids, `kinds/move.ts:39-50`).
 */
export type FrozenFlagsPayload = { accountId: string; entries: FlagsPushEntry[] };

/** The historical spelling: ids plus the patch to apply to them. */
export type ReversedFlagsPayload = { ids?: string[]; messageId?: string; patch: MessageFlagsPatch };

export type FlagsTaskPayload = FrozenFlagsPayload | ReversedFlagsPayload;

export type FlagsTaskDeps = CommitTaskDeps & {
  accessTokenProvider?: AccountAccessTokenProvider;
  agentEvents?: AgentMailEventSink;
  /** The app's event bus and shutdown signal, for the sync kick on a refusal. */
  serverEvents?: ServerEventBus;
  syncAbortSignal?: AbortSignal;
};

export type AcceptFlagsInput = {
  messageIds: readonly string[];
  patch: MessageFlagsPatch;
  /**
   * The undo window the committed tasks open when they complete, or absent for a
   * flags write that offers none. The acceptance does not decide it, because the
   * same code serves two callers: the batch-jobs route with `kind: "flags"`
   * offers an undo (the deleted `acceptFlagsJob` set the window on every row it
   * inserted, `batch-jobs.ts:383-385`), and so does the reverse of a flags undo --
   * an `undo` job carried the window like any other, so undoing a flags undo was
   * possible, and preserving that is what keeps the port faithful. Forgetting it
   * is silent at this call site and shows up later as a `no_window` refusal, which
   * is why §4.3b 第 3 条第 9 项 ② records it as a wiring obligation rather than a
   * default here.
   *
   * Not to be confused with the explicit-id route `PATCH /api/messages/batch/flags`:
   * despite the word "batch" it is not a job and offers no undo -- it hands the
   * caller no id to undo by -- so it passes no window (§4.3b 第 3 条第 9 项 ②'s
   * "旧代码里也只有 job 有撤销").
   */
  undoWindowMs?: number;
  /**
   * The batch job this acceptance's tasks belong to, when a caller is minting one.
   *
   * Optional because the same code serves two shapes: the batch-jobs route
   * (`POST /api/batch-jobs`) answers with a job id the renderer polls and undoes
   * by, and there the id **must** be given -- without it, the slices of one
   * selection get unrelated UUIDs and `handles[0]` (what the route hands out)
   * would resolve one slice while the job holds several: the poll would report a
   * `total` smaller than the selection and `commitJobUndo(handles[0])` would undo
   * one slice and answer 200. The explicit-id message routes pass none, because
   * they hand no id to anyone and so have nothing to make groupable.
   *
   * The obligation that a root be colon-free belongs to the caller that knows it
   * is handing one in (`kinds/move.ts` refuses a colon-bearing one at its entry);
   * see `types.ts`'s `TaskSpec.id` for why no check down here could replace it.
   */
  jobId?: string;
};

export type FlagsTaskAcceptance = {
  /**
   * One handle per committed task -- every account in the selection gets at least
   * one, split at {@link FLAGS_TASK_ENTRY_LIMIT}. All the rows are created inside
   * the caller's transaction; `start()` joins each to its account's chain and must
   * be called after the commit.
   */
  handles: TaskHandle[];
  /** Ids whose requested state is now in force: applied plus already there. */
  updated: number;
  /** Ids the acceptance could not touch: no such row, or a move to reconcile first. */
  failed: number;
  /** Ids whose `flags_json` this commit rewrote, in input order. */
  changedIds: string[];
};

/**
 * The per-message half of a local-first flags commit: the target state, the push
 * marker, and the folder's optimistic unread delta -- the deleted
 * `applyPreparedFlagsInTransaction` (`flags-outbox.ts`), statement for statement,
 * with its queue staging removed.
 *
 * A message already in the requested state is skipped entirely, not written with
 * the same value: it needs no push, so writing it would set
 * `pending_flags_push = 1` with no push behind it, and a marker without a push is
 * a message sync must skip forever (the deleted `clearOrphanedPendingFlagsMarkers`
 * used to repair the builds that managed it; `clearOrphanedFlagsMarkers` in
 * `tasks/settlement.ts` is its one-store replacement). The legacy loop skipped it
 * for the same reason.
 *
 * The baseline CASE and the agent lease are ported verbatim, comment included:
 * the baseline only moves on the TRANSITION into pending, and the lease is taken
 * inside the transaction so agent listeners observe committed state.
 */
function applyPreparedFlagsLocally(
  db: DatabaseHandle,
  prepared: readonly PreparedFlagsChange[],
  agentEvents?: AgentMailEventSink,
): string[] {
  const changedIds: string[] = [];
  const leases = new Map<string, ReturnType<NonNullable<AgentMailEventSink>["acquireLease"]>>();
  // Compiled once for the whole batch: the flags push is otherwise the only
  // writer in this loop, and a selection of n rows used to pay n compilations
  // of the same UPDATE.
  const applyFlags = preparedStatement(
    db,
    `UPDATE messages
      SET flags_json = ?,
          pending_flags_push = 1,
          pending_flags_base_json = CASE WHEN pending_flags_push = 1 THEN pending_flags_base_json ELSE flags_json END
      WHERE id = ?`,
  );
  for (const item of prepared) {
    const { message } = item;
    if (!item.add.length && !item.remove.length) continue;
    applyFlags.run(JSON.stringify(item.nextFlags), message.id);
    changedIds.push(message.id);
    if (agentEvents) {
      const lease = leases.get(message.account_id) ?? agentEvents.acquireLease(message.account_id);
      leases.set(message.account_id, lease);
      if (lease) {
        agentEvents.messageUpsertedWithinTransaction(lease, message.id, {
          mailbox: message.mailbox,
          uid: message.uid,
          remoteIdLookup: message.remote_id_lookup,
          flags: [...item.nextFlags].sort(),
          pendingMoveDestination: message.pending_move_destination,
          pendingMoveState: message.pending_move_state,
        });
      }
    }
  }
  return changedIds;
}

/**
 * The transaction-body half: applies the patch to the local cache and records the
 * tasks that will push each account's delta. **The caller owns the transaction**
 * -- the batch routes open their own, and the undo runner runs it together with
 * the parent's `undone = 1` claim (§4.7 A), which is the reason this half is
 * separate: a reverse patch that commits without consuming the undo would let the
 * same undo be taken twice.
 *
 * The returned `updated`/`failed` are the whole selection's arithmetic, not the
 * sum of the tasks': ids that need no push (already in the requested state) and
 * ids that could not be touched belong to no task, exactly as the legacy kept them
 * out of `entriesByAccount`. The HTTP response is this return value, so what the
 * user is told and what the tasks track are the same numbers by construction --
 * and it is why no task needs an opening report: each task's own `total` is its
 * slice, and its runner is its only counter writer.
 */
export function acceptFlagsTaskInTransaction(deps: FlagsTaskDeps, input: AcceptFlagsInput): FlagsTaskAcceptance {
  const ids = [...new Set(input.messageIds)];
  if (!ids.length || !Object.keys(input.patch).length) return { handles: [], updated: 0, failed: 0, changedIds: [] };
  // `blocked` needs no separate reading: `prepareLocalFlags` keeps a blocked id out
  // of `prepared`, so `ids.length - prepared.length` already counts blocked and
  // missing together (the formula the deleted `commitLocalFlags` used for `failed`).
  const { prepared } = prepareLocalFlags(deps.db, ids, input.patch);
  const appliedIds = applyPreparedFlagsLocally(deps.db, prepared, deps.agentEvents);

  const entriesByAccount = new Map<string, FlagsPushEntry[]>();
  // One read of the account's generations, not one per entry: the acceptance is
  // also a statement-count contract (a 200-id selection must compile no more
  // statements than a 20-id one).
  const generationsByAccount = new Map<string, Map<string, string | null>>();
  for (const item of prepared) {
    if (!item.add.length && !item.remove.length) continue;
    const accountId = item.message.account_id;
    let entries = entriesByAccount.get(accountId);
    if (!entries) {
      entries = [];
      entriesByAccount.set(accountId, entries);
    }
    let generations = generationsByAccount.get(accountId);
    if (!generations) {
      generations = new Map(
        (deps.db.prepare("SELECT path, uid_validity FROM folders WHERE account_id = ?").all(accountId) as Array<{
          path: string;
          uid_validity: string | null;
        }>).map((folder) => [folder.path, folder.uid_validity]),
      );
      generationsByAccount.set(accountId, generations);
    }
    entries.push({
      id: item.message.id,
      mailbox: item.message.mailbox,
      uid: item.message.uid,
      add: item.add,
      remove: item.remove,
      // The generation this UID was synced under. Frozen into the sealed payload
      // because the push can run minutes later: re-reading the cache then would
      // answer with whatever the last pass wrote, which is exactly the value a
      // rebuild changes.
      uidValidity: generations.get(item.message.mailbox) ?? null,
    });
  }

  // Every member this acceptance will commit, counted before the first one is
  // named: the id spelling depends on the total, not on the account (`memberTaskId`).
  const memberCount = [...entriesByAccount.values()]
    .reduce((sum, entries) => sum + Math.ceil(entries.length / FLAGS_TASK_ENTRY_LIMIT), 0);

  const handles: TaskHandle[] = [];
  for (const [accountId, entries] of entriesByAccount) {
    // 1-based, so an account's first slice takes the unnumbered name and a second
    // one gets `:2` -- two slices of one account cannot collide with each other or
    // with the first slice of another account.
    let chunk = 0;
    for (let offset = 0; offset < entries.length; offset += FLAGS_TASK_ENTRY_LIMIT) {
      const slice = entries.slice(offset, offset + FLAGS_TASK_ENTRY_LIMIT);
      chunk += 1;
      const id = input.jobId === undefined ? undefined : memberTaskId(input.jobId, accountId, chunk, memberCount);
      const handle = commitTask(deps, {
        ...(id === undefined ? {} : { id }),
        accountId,
        kind: "flags",
        scope: slice.length > 1 ? "batch" : "single",
        // The slice is this task's account: it can neither over- nor under-deliver,
        // so `updated + failed == total` is a fact about the task rather than a
        // claim about the selection. The rest of the selection is reported by the
        // acceptance's own return value (see above).
        total: slice.length,
        // Every task the acceptance commits is undoable or not as one decision --
        // one window for one user action, not one per account slice.
        undoWindowMs: input.undoWindowMs,
        items: slice.map((entry) => ({ messageId: entry.id, changed: true })),
        payload: { accountId, entries: slice } satisfies FrozenFlagsPayload,
      });
      handles.push(handle);
    }
  }

  return {
    handles,
    // Applied plus already there: both are ids whose requested state is now in
    // force. Deliberately NOT the deleted `commitLocalFlags`' formula
    // (`prepared.length - blocked.length`): a blocked id never enters `prepared`
    // (the `moveActionBlockedError` skip in `flags-outbox.ts:99`), so
    // subtracting it there subtracted it a second time and understated `updated`
    // -- all-blocked went negative -- while `failed` (`ids.length - prepared.length`)
    // already counted it. The legacy pair therefore summed to `ids - blocked`;
    // these two sum to `ids`, which is what lets `updated` answer "how much of
    // this selection is done". Contract §4.7 B3.
    updated: prepared.length,
    failed: ids.length - prepared.length,
    changedIds: ids.filter((id) => appliedIds.includes(id)),
  };
}

/**
 * Accepts a flag patch: local target state plus one durable task per account,
 * committed as one, then starts them.
 *
 * A no-op selection (empty ids, or a patch with no fields) records nothing and
 * returns zeros: there is no state to change and no push to owe.
 */
export function acceptFlagsTask(deps: FlagsTaskDeps, input: AcceptFlagsInput): FlagsTaskAcceptance {
  const accepted = deps.db.transaction(() => acceptFlagsTaskInTransaction(deps, input))();
  for (const handle of accepted.handles) handle.start();
  return accepted;
}

function frozenEntries(payload: FlagsTaskPayload): FlagsPushEntry[] | null {
  const entries = (payload as { entries?: unknown }).entries;
  return Array.isArray(entries) ? (entries as FlagsPushEntry[]) : null;
}

/** Both historical id spellings, in the order the payload names them. */
function reversedMessageIds(payload: FlagsTaskPayload): string[] {
  const shape = payload as { ids?: unknown; messageId?: unknown };
  if (Array.isArray(shape.ids)) return shape.ids.filter((id): id is string => typeof id === "string");
  if (typeof shape.messageId === "string") return [shape.messageId];
  return [];
}

/**
 * The `flags` executor.
 *
 * Frozen spelling: one provider push for the whole slice, then a single report.
 * Reporting once at the end is deliberate and is the opposite of the move runner's
 * per-chunk report (`kinds/move.ts`) -- the reasons are mirror images. A move's
 * read is state-driven, so a chunk report is the only way an exception arriving
 * later cannot lose counts that the next attempt will never see again; a frozen
 * payload is replayed verbatim by every retry, so a per-chunk report would count
 * the same entries again on the next attempt. The attempt that finishes the
 * payload is the only one that reports, which makes "exactly once" structural
 * rather than a property of the provider.
 *
 * Historical spelling: the patch is accepted afresh -- local target state plus a
 * new `flags` task per account -- and the acceptance's numbers are reported. It
 * is deliberately not a port of `updateMessageFlagsBatch`'s remote-first body:
 * the scheduler already holds the account write slot when a runner runs
 * (`scheduler.ts:155-157`), so calling anything that takes
 * `withAccountWriteLocks` from here would nest the same lock, and remote-first is
 * the thing this batch replaces. Draining an old row therefore converges onto the
 * new pipeline instead of keeping a second executor alive (contract §4.7 B3).
 * The id-less `{patch}` row job-derived migration can produce settles as a no-op
 * rather than aborting: it names nothing to change.
 *
 * A payload that is neither spelling is not retryable -- no attempt can turn it
 * into one -- so it aborts on the first sighting, the same judgement as the move
 * runner's missing payload.
 */
export function createFlagsRunner(deps: FlagsTaskDeps): TaskRunner<FlagsTaskPayload> {
  return async ({ task, payload, report, signal }) => {
    if (!payload) throw new TaskAbortError("failed", `Task "${task.kind}" carries no payload.`, "no_payload");
    const entries = frozenEntries(payload);
    if (entries) {
      try {
        // The signal goes to the push so a timeout closes the socket instead of
        // leaving the STORE running under a released account slot.
        const { pushed, dropped, generationChanged } = await pushFlagsRemote(flagsPushDeps(deps), { accountId: task.account_id, entries }, signal);
        report({ updated: pushed, failed: dropped });
        // The dropped entries whose mailbox was rebuilt: a pass is what re-learns
        // the folder (and hands the local state back through the settlement hook),
        // so it is kicked rather than left to the next scheduled one.
        if (generationChanged) kickAccountSync(deps, task.account_id, "Background resync after a refused flags push failed");
        return;
      } catch (error) {
        // The same trade the send runner's transport catch makes (contract §十七
        // (9)): this is where a push's error object meets the task row, and the
        // row's `error_message` is rendered -- `jobSnapshot` hands it to the batch
        // poller, which toasts it verbatim (`batchJobRunner.ts:179`). So the
        // push's own already-user-facing refusals pass through and a socket's text
        // does not; `flagsPushError` is that split, kept next to the throws whose
        // wording it protects.
        //
        // Deliberately still a plain `Error` and not `TaskAbortError`: everything
        // this arm can throw is retryable (an auth failure the user can fix, a
        // "wait your turn" refusal, a connection that dropped). The safe pair
        // rides on the object for `failureOf` to read into the row, and the raw
        // error stays reachable as `cause`, in-process.
        const failure = flagsPushError(error);
        throw Object.assign(new Error(failure.message), {
          ...(failure.code ? { code: failure.code } : {}),
          cause: error,
        });
      }
    }
    if (!("patch" in payload)) {
      throw new TaskAbortError("failed", `Task "${task.kind}" carries a payload this runner cannot execute.`, "unknown_payload");
    }
    const rejected = payload as ReversedFlagsPayload;
    const ids = reversedMessageIds(payload);
    if (!ids.length || !rejected.patch || !Object.keys(rejected.patch).length) return;
    const accepted = acceptFlagsTask(deps, { messageIds: ids, patch: rejected.patch });
    report({ updated: accepted.updated, failed: accepted.failed });
  };
}

/** An exact-optional-property spread, so `exactOptionalPropertyTypes` stays happy. */
function flagsPushDeps(deps: FlagsTaskDeps): { db: DatabaseHandle; masterKey: Buffer; accessTokenProvider?: AccountAccessTokenProvider } {
  return deps.accessTokenProvider
    ? { db: deps.db, masterKey: deps.masterKey, accessTokenProvider: deps.accessTokenProvider }
    : { db: deps.db, masterKey: deps.masterKey };
}
