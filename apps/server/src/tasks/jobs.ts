import type { DatabaseHandle } from "../db.js";
import type { FlagsTaskDeps } from "./kinds/flags.js";
import { commitUndoTask, undoPreflightRefusal, type UndoRefusalReason } from "./kinds/undo.js";
import { rootJobId } from "./job-ids.js";
import { taskRow } from "./store.js";
import { TASK_TERMINAL_STATUSES } from "./types.js";

/**
 * The `/api/batch-jobs/*` compatibility alias: one user-visible job id, resolved
 * to the tasks one acceptance committed for it.
 *
 * ## Why a job is a projection now
 *
 * A job used to be a row of its own (`batch_jobs` + `batch_job_messages`) that
 * the executor nudged, so a progress read *was* "read the row". Under the task
 * layer the same user-visible thing is **the set of tasks one acceptance
 * committed**, and each member's `total/updated/failed` is written by that
 * member's own runner. There is therefore nothing to read a second time -- and,
 * more to the point, nothing that can drift from the runners' own numbers. The
 * legacy also needed the row for a reason that has since evaporated: its executor
 * was a `batch-move` chunk row that did not know which job it belonged to, so
 * "how far along is this job" was only answerable from the job's own bookkeeping
 * (`MOVE_JOB_PROJECTION_SQL`, `batch-jobs.ts:414-455`, both deleted). A task's
 * runner is the only writer of its own progress, so the question now has a
 * direct answer.
 *
 * ## How a job id names its members
 *
 * The migration fixed this and this module follows it rather than inventing a
 * second rule (`migrate.ts:526-529`): a job's account set gets one task each,
 * carrying **the legacy job id verbatim** when there is exactly one account and
 * `${jobId}:${accountId}` when the job spans accounts. Members are therefore
 * found by **prefix**, anchored at the colon:
 * `substr(id, 1, length(jobId) + 1) = jobId || ':'` cannot match a bare UUID, and
 * a job id that is a mere prefix of another (`job-1` vs `job-10:acc-1`) reaches
 * nothing. A `LIKE` would need its metacharacters escaped first, and the id here
 * comes from a URL path segment.
 *
 * The account suffix is what makes this more than a prefix match. A job that
 * spans accounts has **no bare member at all** (`kinds/move.ts:473-481`: the id is
 * `${jobId}:${accountId}` whenever there is more than one account), so the id a
 * caller is most likely to hold -- `taskIds[0]` from the acceptance, which is what
 * the renderer polls and then undoes with -- is a *member's*, and answering it with
 * that account's slice alone would settle the job when the first account finished
 * and half-undo a move that reached two. An id is therefore resolved through its
 * **root** (the part before the first colon; both a job id and an account id are
 * colon-free UUIDs) and then *verified*: the root's members are the answer only
 * when the queried id is one of them or is the root itself. That keeps `job-1:acc`
 * -- a prefix of a member, naming nothing -- a 404 instead of a silent lookup of
 * `job-1`, which matters because the id arrives as a URL path segment.
 *
 * One consequence is deliberate: the bare id also matches `id = jobId`, the
 * single-account spelling *and* the id a lone task returns, so asking about **any**
 * id a job produced resolves the whole job. `commitJobUndo` leans on that.
 *
 * ## Reading the members' numbers: two shapes, one rule
 *
 * Every task this layer commits reports **its own slice**: `total` is the number
 * of ids it carries (`plan.items.length`, `slice.length`) and its runner counts
 * that slice and nothing else. The migration could not do that -- the legacy's
 * three numbers were *job-level*, and the per-account split was never stored --
 * so it copied them column for column into every member (`migrate.ts:542-547`,
 * which says so in as many words). Two provenances, two readings of the same
 * truth, and no marker left to tell them apart: `payload_version` looks like one,
 * but `sealMigratedTaskPayloads` re-seals migrated rows at startup, so it is gone
 * by the time anything can be served.
 *
 * The rule that reads both is structural rather than provenance-based: **a member
 * that claims more progress than it carries is reporting for the whole job**
 * (`total > COUNT(task_items)` -- impossible for a slice, and exactly the legacy
 * copy's shape whenever the job has more than one account or lost an id in
 * migration). A job's members come from one acceptance or one migration, never a
 * mix, so one such member means all of them, and the job's numbers are then that
 * reading taken **once** -- `Σ − (n − 1) × min`, which is the copies' shared
 * baseline removed from each duplicate. Otherwise the members are slices and the
 * job's numbers are their **sum**.
 *
 * This is exact for every job the task layer accepts, forever. For a migrated job
 * it is exact in `total` (the copies are identical, so `Σ − (n−1)min` returns the
 * legacy job total) and, in `updated`/`failed`, a **lower bound** that is exact
 * while any member still holds its baseline: each member's column is that baseline
 * plus its own arrivals, and the baseline itself is stored nowhere, so a job whose
 * every account has advanced cannot be read back exactly. A lower bound is the
 * safe direction -- the numbers never claim progress that has not happened -- and
 * the completion state is exact for every job the task layer accepted, and for a
 * migrated job in every shape but one the migration cannot record (see the status
 * section below), because the legacy's own settled branch is `done = row.total`,
 * which is what a job with every member terminal reports here (`owed` is zero by
 * then). While it runs, the legacy's `row.total - syncing` and this module's
 * `total - (total - updated - failed)` are the same number read from the same
 * three columns.
 *
 * The rule rests on one property, which `TaskSpec.total`'s doc deliberately leaves
 * open and this module needs closed: **a committed task's `total` does not exceed
 * the ids it carries** except for a migrated copy. Contract §10 records it as an
 * obligation on any acceptance that passes a non-row-count `total`.
 *
 * ## The status vocabulary is exhaustive, not a fallback
 *
 * `pending`/`running` → `"running"`; `completed` → `"completed"`; `failed` →
 * `"failed"`; `cancelled`/`unknown_delivery` → `"failed"`. The last line is the
 * one that had to be *chosen*: the renderer's only two branches are the error one
 * and the success one, and its default (anything it does not recognise) is
 * **success with an undo button** -- K5's silent failure. Adding a fourth value to
 * the wire type instead would land on exactly that default. A job still runs while
 * *any* member is non-terminal: the members are one user action across accounts,
 * so the job is not settled until the last one is (contract §8 G11's direction).
 *
 * Once settled, only a job with **nothing** through it reads `failed`. `failed` is
 * the one terminal status whose promise is broken and whose items the settlement
 * hook puts back (`scheduler.ts:184-186` -- the move hook fires on `failed` alone),
 * so a job with any member `completed` has a half that is in force, and `updated`/
 * `failed` are the two numbers that describe it. Reading such a set as `failed`
 * would throw both away *and* the one-shot undo: `batchJobRunner.ts:150-157` answers
 * `failed` with a single generic toast, while its completed branch is the one that
 * says "N 封操作成功，M 封失败" and offers the undo (`:183-191`). The legacy agreed:
 * `batch_jobs.status` is never written `failed` anywhere (`migrate.ts:442-444`), so
 * a partially failed job reached the renderer as `completed` with counts. That set
 * is routine for this layer rather than exotic, because members are per account and
 * one account's expired credentials produce exactly it.
 *
 * `cancelled` and `unknown_delivery` have no writer in this layer today. Whoever
 * adds one owes the question this mapping answers conservatively: nothing reverts a
 * cancelled task's items, so reading it as a finished job would leave the local
 * target state claiming a write that never reached the provider.
 *
 * ## The one shape that reads settled before it is
 *
 * A migrated `move` job's row *carries* its work: it is `pending` exactly while a
 * legacy chunk was still live (`migrate.ts:433-441`). A migrated flags/undo job's
 * row is only the **record** of an acceptance -- its executor is a `flags-push`
 * queue row, migrated as a task of its own -- so the migration writes it terminal
 * whether or not that push had finished (`migrate.ts:433-441`, `jobTaskStatus` at
 * `:446-449`), and this module therefore reports `completed` with `done = total` for
 * a job the legacy still called `running` (the deleted `batch-jobs.ts:433-454`
 * answered `done = total - syncing` from the queue). The link that would let this
 * module do better was never stored: the migrated push task is seeded from its own
 * queue row's id (`migrate.ts:335-336`), its payload carries no job id
 * (`FrozenFlagsPayload`, `kinds/flags.ts:59`), and one queue row can serve several
 * jobs -- so no join recovers it, and the fact that the legacy row was `running` is
 * not representable as a task status (a `pending` record-only row would be claimed
 * by the scheduler and run a payload that names nothing).
 *
 * The exposure is what makes documenting it proportionate: the renderer polls job
 * ids it obtained in the same session (`batchJobRunner.ts:91` keeps them in an
 * in-memory `Map`), the migration runs at startup, and nothing in this build reads
 * `batch_jobs` any more -- the DDL stopped declaring the three legacy tables in
 * batch 4, and the migration that drops them for good lands with the 4b mount --
 * so what can read this shape is an API client holding an id from before the
 * upgrade, not the app. Contract §九 D12 records it as this module's one known
 * inexactness.
 *
 * ## Ordering: the read and the writes switched together, and both have
 *
 * A job lives in exactly one place at a time, so this read could not be switched on
 * its own: `routes/batch-jobs.ts` answered from `getBatchJobSnapshot` (which read
 * `batch_jobs`) while the acceptances still wrote that table, and turning this
 * module on first would have 404'd every job created between the two switches. The
 * read and the five write paths (contract §0.4 第 3 件 · 2 / · 3 / · 4) therefore
 * landed as one batch, which is now in: `routes/batch-jobs.ts:117` calls
 * `jobSnapshot`, and the acceptances write `tasks`.
 */

/** The wire vocabulary, unchanged from `BatchJobSnapshot` on both sides. */
export type JobAliasKind = "flags" | "move" | "undo";
export type JobAliasStatus = "running" | "completed" | "failed";

/**
 * One job, as `GET /api/batch-jobs/:id` reports it.
 *
 * Field for field the legacy shape (`batch-jobs.ts:71-83`, deleted; its live
 * counterpart is `batchJobTypes.ts:49-61`):
 * progress numbers only, no id list, and the optional three only when they mean
 * something. `undone` is per member on the task side and is reported as true when
 * any of them was undone. The renderer does not branch on it -- a click after the
 * window or after a successful undo gets the refusal's own `reason` and says what
 * happened (`batchJobRunner.ts`'s refusal mapping) -- but it is carried because the
 * alias is the only place the fact survives and the shape had it.
 */
export type JobAliasSnapshot = {
  id: string;
  kind: JobAliasKind;
  status: JobAliasStatus;
  total: number;
  done: number;
  updated: number;
  failed: number;
  createdAt: number;
  error?: string;
  undone?: boolean;
  undoWindowMs?: number;
};

export type JobUndoOutcome = { ok: true; taskIds: string[] } | { ok: false; reason: UndoRefusalReason };

type JobMember = {
  id: string;
  kind: JobAliasKind;
  status: string;
  total: number;
  updated: number;
  failed: number;
  createdAt: number;
  errorMessage: string | null;
  undone: boolean;
  undoWindowMs: number | null;
  /** How many ids this member actually carries -- see the header's reading rule. */
  itemCount: number;
};

type RawMemberRow = {
  id: string;
  kind: string;
  status: string;
  total: number;
  updated: number;
  failed: number;
  created_at: number;
  error_message: string | null;
  undone: number;
  undo_window_ms: number | null;
  item_count: number;
};

/**
 * Member rows of one job, plus the count each member carries.
 *
 * The subquery rides `task_items`' primary key (`task_id, message_id`), so the
 * count is an index scan of exactly that member's selection.
 */
const JOB_MEMBERS_SQL = `
  SELECT
    t.id, t.kind, t.status, t.total, t.updated, t.failed,
    t.created_at, t.error_message, t.undone, t.undo_window_ms,
    (SELECT COUNT(*) FROM task_items i WHERE i.task_id = t.id) AS item_count
  FROM tasks t
  WHERE t.id = ? OR substr(t.id, 1, length(?) + 1) = ? || ':'
  ORDER BY t.id
`;

/**
 * A member of a batch job: the kinds a job consists of.
 *
 * `undo` belongs here rather than being a foreign body. The legacy tracked a flags
 * undo as a job of its own (a `batch-jobs.ts:1031` row, deleted, with
 * `kind: "undo"`), the migration carried that over as one job with one member per
 * account -- `migrate.ts:526-529` names them `${undoJobId}:${accountId}` and
 * `planJob` keeps the kind -- and the
 * renderer polls it by the id the undo answered (`batchJobRunner.ts:168-176`
 * follows `result.jobId`). Leaving `undo` out of this filter made a migrated
 * cross-account undo job's own root id resolve to *nothing* while each member id
 * resolved to a single account: one job with two answers, neither of them the job.
 */
function isJobKind(kind: string): kind is JobAliasKind {
  return kind === "move" || kind === "flags" || kind === "undo";
}

/**
 * Whether the alias may call this member settled.
 *
 * A whitelist rather than `status !== "pending" && status !== "running"`: a stored
 * status outside the vocabulary is what a build that wrote one this build does not
 * know leaves behind (the premise `types.ts` states for `kind`), and the honest
 * reading of "unknown" is "not settled". That is also §8 G11's direction -- the
 * alias must never settle a job early -- while the *reverse* mistake is the one
 * with a user-visible cost (the renderer reads a settled job as a finished one).
 */
function isSettled(status: string): boolean {
  return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

function toMember(row: RawMemberRow): JobMember {
  return {
    id: row.id,
    kind: row.kind as JobAliasKind,
    status: row.status,
    total: row.total,
    updated: row.updated,
    failed: row.failed,
    createdAt: row.created_at,
    errorMessage: row.error_message,
    undone: row.undone !== 0,
    undoWindowMs: row.undo_window_ms,
    itemCount: row.item_count,
  };
}

/**
 * The tasks one job id resolves to, ordered by id so every reading of them is
 * deterministic.
 *
 * Two lookups, and the second is not a fallback for a missing job: a batch job is
 * its members, while a lone task **is** its own job. The second shape is what the
 * legacy's `undo` job became (one row of kind `undo`, whose own id the renderer
 * follows) and what a single-account acceptance's bare id resolves to.
 *
 * The root's members are only the answer when the queried id is one of them or is
 * the root: `rootJobId` is a guess about a string that came from a URL, and this is
 * where the guess is checked rather than trusted.
 */
function resolveJobMembers(db: DatabaseHandle, jobId: string): JobMember[] {
  const root = rootJobId(jobId);
  const rows = db.prepare(JOB_MEMBERS_SQL).all(root, root, root) as RawMemberRow[];
  const members = rows.filter((row) => isJobKind(row.kind)).map(toMember);
  if (members.length && (root === jobId || members.some((member) => member.id === jobId))) return members;
  const own = taskRow(db, jobId);
  if (own && isJobKind(own.kind)) {
    const itemCount = db.prepare("SELECT COUNT(*) FROM task_items WHERE task_id = ?").pluck().get(jobId) as number;
    return [{
      id: own.id,
      kind: own.kind,
      status: own.status,
      total: own.total,
      updated: own.updated,
      failed: own.failed,
      createdAt: own.created_at,
      errorMessage: own.error_message,
      undone: own.undone !== 0,
      undoWindowMs: own.undo_window_ms,
      itemCount,
    }];
  }
  return [];
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * The copies' one reading: their sum minus the `(n - 1)` baseline repeats.
 *
 * For identical copies (`n × v`) this is `v`, which is the whole point; for a
 * single member it is that member's own number, so the caller never has to
 * special-case a lone member.
 */
function readOnce(values: readonly number[]): number {
  if (!values.length) return 0;
  return sum(values) - (values.length - 1) * Math.min(...values);
}

/**
 * One job, or `null` when the id names neither a job nor a job-like task.
 *
 * `null` is the route's 404 (and the legacy's `"批量任务不存在。"`), so it has to
 * mean "nothing here", not "here but unreadable": the kind filter above is the
 * only thing that can empty a non-empty prefix match, and an id that reaches a
 * `send`/`draft`/`snooze` task is not a job in any reading.
 */
export function jobSnapshot(db: DatabaseHandle, jobId: string): JobAliasSnapshot | null {
  const members = resolveJobMembers(db, jobId);
  const first = members[0];
  if (!first) return null;

  // A member that claims more than it carries is reporting the whole job's
  // numbers (only a migrated copy can), and its siblings are the same copy.
  const jobLevel = members.some((member) => member.total > member.itemCount);
  const read = jobLevel ? readOnce : sum;

  const total = read(members.map((member) => member.total));
  const updated = read(members.map((member) => member.updated));
  const failed = read(members.map((member) => member.failed));
  const running = members.some((member) => !isSettled(member.status));
  // The legacy's two `done` branches, reproduced from the aggregated numbers: a
  // settled job has finished all of its selection whatever its columns add up to
  // (a migrated record-only job reads `total 5, updated 0, failed 0, completed`,
  // and the old branch answered `row.total` for it), while a running one has
  // finished all but what its own three numbers say is left. The clamp is still
  // needed with `reportTaskProgress` stopping each counter at its member's `total`
  // (`store.ts`): the two counters can *sum* past it, because a message one attempt
  // delivered and another reported failed is counted in both.
  const owed = Math.max(0, total - updated - failed);
  const error = members.find((member) => member.errorMessage !== null)?.errorMessage;
  const undoWindowMs = Math.max(...members.map((member) => member.undoWindowMs ?? 0));
  const createdAt = Math.min(...members.map((member) => member.createdAt));

  return {
    id: jobId,
    kind: first.kind,
    // Exhaustive, and the two statuses with no wire equivalent take the error
    // branch -- the renderer's fallback direction is success (K5). Only a job with
    // *nothing* through it reads `failed`; one mixed member set is the legacy's
    // partial failure, which it reported as `completed` with both numbers filled
    // in -- `batch_jobs.status` is never written `failed` anywhere
    // (`migrate.ts:442-444`), and `batchJobRunner.ts:150-157` answers `failed` with a
    // single generic toast, dropping the counts *and* the undo button its completed
    // branch would have offered (`:183-191`). Post-switch that set is routine rather
    // than exotic: members are per account, so one account's expired credentials
    // produce exactly it.
    status: running
      ? "running"
      : members.some((member) => member.status === "completed")
        ? "completed"
        : "failed",
    total,
    done: running ? total - owed : total,
    updated,
    failed,
    createdAt,
    ...(error === null || error === undefined ? {} : { error }),
    ...(members.some((member) => member.undone) ? { undone: true } : {}),
    ...(undoWindowMs === 0 ? {} : { undoWindowMs }),
  };
}

/**
 * Undoes one job, whichever member id the caller asked about, fanning out over
 * every member of it.
 *
 * The fan-out is the whole reason this is not just `commitUndoTask`: a job's
 * reverse is per member (each member's selection is its own account's ids), and
 * undoing one account of a cross-account move would leave the other account at
 * the destination while still answering 200 (contract §0.4 第 3 件 · 4 ③).
 *
 * ## Why the guard runs first
 *
 * `commitUndoTask` claims (`undone = 1`) and reverses in one transaction, so a
 * claim is spent by whoever takes it. A fan-out that discovered a refusal at the
 * *second* member would have claimed the first one already: the user is told the
 * undo failed while one account's messages are on their way back. Every member is
 * therefore pre-checked with `undoPreflightRefusal` -- **the same function
 * `commitUndoTask` answers first**, including the payload reads, not just the
 * `undoRefusal` predicate -- before any of them is claimed, which leaves the
 * multi-member case with the same "a refused undo commits nothing" property the
 * single-member case has (`task-undo.test.ts`). Sharing the function is what makes
 * that a property rather than a coincidence: the refusals answered before the claim
 * have one definition, so this loop cannot be a clause weaker than the path it
 * guards, and a payload this build cannot read throws here -- before anything is
 * claimed -- instead of mid-loop.
 *
 * What that guard cannot cover is a *race*: another caller claiming a member
 * between the two loops. Expiry is not one of them, because both loops take this
 * call's single `now`; and a member that was terminal in the first loop cannot stop
 * being terminal, since every claim carries the same terminal status list
 * (`CLAIM_UNDO_SQL` in `kinds/undo.ts`). So
 * only one race serves the user's intent -- `already_undone`, i.e. someone else is
 * undoing this same job -- and that one is carried on with rather than reported,
 * while any other is reported as itself. The reason the single-member path reports
 * each of them verbatim is that the guard had not run: there the refusal *is* the
 * answer.
 */
export function commitJobUndo(deps: FlagsTaskDeps, jobId: string, now: number = Date.now()): JobUndoOutcome {
  const members = resolveJobMembers(deps.db, jobId);
  if (!members.length) return { ok: false, reason: "not_found" };
  const ids = members.map((member) => member.id);

  for (const id of ids) {
    const parent = taskRow(deps.db, id);
    if (!parent) return { ok: false, reason: "not_found" };
    const refusal = undoPreflightRefusal(deps, parent, now);
    if (refusal) return { ok: false, reason: refusal };
  }

  const taskIds: string[] = [];
  for (const id of ids) {
    const outcome = commitUndoTask(deps, id, now);
    if (!outcome.ok) {
      if (outcome.reason === "already_undone") continue;
      return { ok: false, reason: outcome.reason };
    }
    taskIds.push(...outcome.taskIds);
  }
  return { ok: true, taskIds };
}
