import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../src/db.js";
import { migrateTaskStorageInTransaction, taskItems, taskRow } from "../src/tasks/index.js";
import { pendingMoveItemIds, revertMoveFailures } from "../src/tasks/kinds/move.js";
import { withFixture } from "./helpers/legacy-store.js";

/**
 * The move half of the settlement surface: the two questions a settling move
 * task asks, run against the same frozen pre-batch-2 snapshot the migration test
 * migrates.
 *
 * Two things make this file worth its own fixture run rather than a synthetic
 * database. The first is that the fixture contains a real *cross-account* move
 * job (`a9fdcd39`: eleven selection rows over three accounts, one of which was
 * removed, so two of the rows name a message that no longer exists) next to a
 * *single-account* one (`b6c094b3`), and that pair is
 * the whole reason these functions take a `TaskRow` instead of an id: the
 * migration keeps the bare uuid as the task id when a job belongs to one account
 * and writes `${jobId}:${accountId}` when it spans accounts (`migrate.ts:529`),
 * so "the id out of the executor's payload" resolves for one of these jobs and
 * matches nothing for the other -- and matching nothing does not throw, it
 * returns an empty list while the messages keep the goal that hides them from
 * every list view. The second is the count arithmetic: `folders` in this fixture
 * is the drifted legacy state (acc-beta's INBOX reads `total 0, unseen 1`), so
 * the expectations below are computed from that table rather than from a
 * re-anything.
 *
 * Rows are edited in the copy when a test needs a shape the snapshot does not
 * contain (the same carve-out the migration test makes, §4.3b item 6). The
 * fixture files are never written.
 */

const ALPHA = "acc-alpha";
const BETA = "acc-beta";
/** The cross-account move job: `a9fdcd39:acc-alpha` and `a9fdcd39:acc-beta`. */
const CROSS_ACCOUNT_MOVE = "a9fdcd39-76c0-4d58-aee0-4bdf0a230b36";
/** The move job whose queue rows were pruned: one account, so the bare uuid. */
const SINGLE_ACCOUNT_MOVE = "b6c094b3-e532-4334-b953-cf68a29665bf";

const withMigrated = <T,>(body: (db: DatabaseHandle) => T): T =>
  withFixture((db) => {
    // Asserted rather than assumed: every test below reads `tasks`/`task_items`,
    // and a migration that decided it had already run would leave them empty --
    // which would let the structural tests pass while every behavioural one
    // failed for a reason that had nothing to do with the code under test.
    expect(migrateTaskStorageInTransaction(db).ran).toBe(true);
    return body(db);
  });

/**
 * The task row, narrowed. Asserted rather than cast so a missing row names
 * itself instead of failing on a property read five lines later.
 */
const moveTask = (db: DatabaseHandle, id: string) => {
  const task = taskRow(db, id);
  expect(task, `${id} must have survived the migration`).toBeDefined();
  return task!;
};

const goalOf = (db: DatabaseHandle, id: string): Record<string, unknown> =>
  db
    .prepare(`
      SELECT pending_move_destination AS destination,
             pending_move_state AS state,
             pending_move_special_use AS specialUse,
             pending_move_candidate_uid AS candidateUid
      FROM messages WHERE id = ?
    `)
    .get(id) as Record<string, unknown>;

const NO_GOAL = { destination: null, state: null, specialUse: null, candidateUid: null };

/**
 * The two badge numbers of one folder, derived from the messages the way the
 * sidebar derives them (contract §4.5, I4).
 *
 * The fixture's `folders` rows carry a *drifted* pair of legacy counters (README:
 * `acc-beta`'s INBOX reads `total 0, unseen 1`), and these assertions used to read
 * them literally. Batch 3 dropped the columns (contract §3.6), so what is read now
 * is the placement of the rows -- which is precisely the drift the old readings
 * could not see. `effective_mailbox` is the generated target-folder column
 * (db-schema.ts), so a row carrying a move goal counts in its destination and a row
 * whose move is in flight counts at its source.
 */
const folderCounts = (db: DatabaseHandle, accountId: string, path = "INBOX"): { total: number; unseen: number } => {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ?").get(accountId, path) as { n: number }).n;
  const unseen = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ? AND flags_json NOT LIKE '%\\Seen%'").get(accountId, path) as { n: number }).n;
  return { total, unseen };
};

const itemOf = (db: DatabaseHandle, taskId: string, messageId: string) => {
  const item = taskItems(db, taskId).find((row) => row.message_id === messageId);
  expect(item, `${messageId} must be a selection row of ${taskId}`).toBeDefined();
  return item!;
};

const setFlags = (db: DatabaseHandle, id: string, flags: string[]): void => {
  db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify(flags), id);
};
const setGoal = (db: DatabaseHandle, id: string, destination: string | null, state: string | null): void => {
  db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = ? WHERE id = ?")
    .run(destination, state, id);
};
const setMailbox = (db: DatabaseHandle, id: string, mailbox: string): void => {
  db.prepare("UPDATE messages SET mailbox = ? WHERE id = ?").run(mailbox, id);
};
const setItemFlag = (db: DatabaseHandle, column: "changed" | "failed", taskId: string, messageId: string): void => {
  db.prepare(`UPDATE task_items SET ${column} = ? WHERE task_id = ? AND message_id = ?`).run(column === "changed" ? 0 : 1, taskId, messageId);
};

describe("task move settlement: the work a move task still owes", () => {
  it("reads a split job's work off its own member row, and the bare job id names no task", () => {
    withMigrated((db) => {
      const alpha = moveTask(db, `${CROSS_ACCOUNT_MOVE}:${ALPHA}`);
      // What the member owns, and why the list below is shorter than the job's
      // eleven rows: the selection splits 7/2 across the job's two live accounts,
      // the two rows naming a message of the removed third account are dropped by
      // the migration (`migrate.ts:504-505` -- an item with no resolvable message has
      // no account, and `tasks.account_id` is NOT NULL), and one of alpha's seven
      // carries `changed = 0` because acceptance found no work for it (that
      // message was already moving: it holds the fixture's stale `intent`).
      expect(taskItems(db, `${CROSS_ACCOUNT_MOVE}:${ALPHA}`).map((row) => row.message_id)).toEqual([
        "fx-alpha-inbox-8",
        "fx-alpha-inbox-7",
        "fx-alpha-inbox-5",
        "fx-alpha-inbox-4",
        "fx-alpha-inbox-3",
        "fx-alpha-inbox-2",
        "fx-alpha-inbox-1",
      ]);
      // Selection order, minus that one row.
      expect(pendingMoveItemIds(db, alpha)).toEqual([
        "fx-alpha-inbox-8",
        "fx-alpha-inbox-7",
        "fx-alpha-inbox-5",
        "fx-alpha-inbox-4",
        "fx-alpha-inbox-2",
        "fx-alpha-inbox-1",
      ]);

      // The trap this signature exists for. A job that spans accounts has no task
      // under its own id -- only the two members do -- so a helper that took "the
      // id out of the payload" would find nothing here. The forged row below is
      // what that call would return: an empty list, no throw, no log line, and
      // every one of those six messages left with a goal that keeps the list
      // projection hiding it. Nothing a caller can obtain from `taskRow` has this
      // shape, which is why the parameter is the row.
      expect(taskRow(db, CROSS_ACCOUNT_MOVE)).toBeUndefined();
      expect(pendingMoveItemIds(db, { ...alpha, id: CROSS_ACCOUNT_MOVE })).toEqual([]);

      // The account clause, which nothing else here would notice: every selection
      // row of this member is an alpha row by construction, so the filter can only
      // discriminate when it is handed the wrong account -- and a member of a
      // cross-account job is exactly where a caller gets one by mistake, since the
      // id it is reached by already carries an account suffix. Drop
      // `AND m.account_id = ?` and this call returns the six ids above.
      expect(pendingMoveItemIds(db, { ...alpha, account_id: BETA })).toEqual([]);
    });
  });

  it("keeps the bare job id when the job belongs to one account", () => {
    withMigrated((db) => {
      // The other half of the trap: the same call, the same job shape, resolving
      // because a single-account job's id is its own uuid. A bug here is invisible
      // to whichever of the two shapes a test happens to use.
      const task = moveTask(db, SINGLE_ACCOUNT_MOVE);
      expect(task.account_id).toBe(BETA);
      expect(pendingMoveItemIds(db, task)).toEqual(["fx-beta-inbox-4", "fx-beta-inbox-3"]);
    });
  });

  it("drops a row the moment it is claimed, arrived, re-goaled, latched or untouched", () => {
    withMigrated((db) => {
      const alphaTask = `${CROSS_ACCOUNT_MOVE}:${ALPHA}`;
      const alpha = moveTask(db, alphaTask);
      const read = () => pendingMoveItemIds(db, alpha);

      // Six edits over the four exclusion clauses, each on a distinct message, so
      // the one that stopped working is the one that fails. Two of them (`intent`
      // then `confirmed`) both exercise the *state* clause, and that pair is the
      // point: one row leaves by one clause for two different reasons. Together
      // they are what makes a retry *resume* instead of replay -- an id in any of
      // these states is either already in the provider's hands or no longer this
      // task's business.
      setGoal(db, "fx-alpha-inbox-8", "Archive", "intent");
      expect(read()).toEqual(["fx-alpha-inbox-7", "fx-alpha-inbox-5", "fx-alpha-inbox-4", "fx-alpha-inbox-2", "fx-alpha-inbox-1"]);
      // The reconcile's own arrival: it KEEPS the goal and sets the state
      // (sync-move-statements.ts:197), so the state clause is the only thing that
      // can catch it. A reading that tested "is it in the destination folder"
      // instead would miss this row entirely -- its mailbox still reads INBOX.
      setGoal(db, "fx-alpha-inbox-8", "Archive", "confirmed");
      expect(read()).toEqual(["fx-alpha-inbox-7", "fx-alpha-inbox-5", "fx-alpha-inbox-4", "fx-alpha-inbox-2", "fx-alpha-inbox-1"]);

      // A UIDPLUS arrival, written the way the statement writes it: the mailbox
      // moves and the goal is cleared together. Both halves are set here because
      // both halves are set there; only the goal half is what this query reads.
      setGoal(db, "fx-alpha-inbox-7", null, null);
      setMailbox(db, "fx-alpha-inbox-7", "Archive");
      expect(read()).toEqual(["fx-alpha-inbox-5", "fx-alpha-inbox-4", "fx-alpha-inbox-2", "fx-alpha-inbox-1"]);

      // The user re-moved it while this task was still retrying. The newer
      // decision owns it -- and note the goal has to *differ* from the selection's
      // destination, not merely exist, which is why the join compares the two.
      setGoal(db, "fx-alpha-inbox-5", "Trash", null);
      expect(read()).toEqual(["fx-alpha-inbox-4", "fx-alpha-inbox-2", "fx-alpha-inbox-1"]);

      setItemFlag(db, "failed", alphaTask, "fx-alpha-inbox-4");
      expect(read()).toEqual(["fx-alpha-inbox-2", "fx-alpha-inbox-1"]);

      setItemFlag(db, "changed", alphaTask, "fx-alpha-inbox-2");
      expect(read()).toEqual(["fx-alpha-inbox-1"]);
    });
  });

  it("owes nothing for the member whose selection already gave up, read or reverted", () => {
    withMigrated((db) => {
      // `fx-beta-inbox-1`/`-2` are the cross-account job's two given-up rows
      // (fixture boundary 10: written by `revertMoveJobFailures` itself, the only
      // writer of that column), and they are the reason the beta member exists at
      // all: its work is settled, so it must fall out of both the read and the
      // revert.
      const beta = moveTask(db, `${CROSS_ACCOUNT_MOVE}:${BETA}`);
      expect(pendingMoveItemIds(db, beta)).toEqual([]);
      // But an empty *read* would prove less than it looks like: those two rows
      // are excluded by the latch AND by their goal, which the give-up cleared in
      // the same pass, so either clause alone produces the same empty list.
      // Handing both ids to the revert anyway is what isolates the latch -- and
      // the caller is the right place to test it, because `revertMoveFailures`
      // takes its ids as an argument rather than re-deriving them, so a task
      // handed a stale list must still refuse. Delete `failed = 0` from either
      // statement and this call gives the beta folder a count back.
      //
      // Both numbers are zero, and the `latched` one is the sharper half: these
      // rows already carry the latch (the fixture's boundary 10 records them as
      // written by this very function), so this call has nothing left to mark
      // either. A revert that re-latched them would report 2.
      expect(revertMoveFailures(db, beta, ["fx-beta-inbox-1", "fx-beta-inbox-2"])).toEqual({ reverted: 0, latched: 0 });
      // And the rows are still *in* the Inbox -- the give-up cleared their goals,
      // so this is where they read -- which is what makes the empty work list
      // above a statement about the latch rather than about them having left.
      // There is no count for a wrong revert to move here any more (contract
      // §3.6), which is why the numbers are asserted as the fixture's placement
      // and not as a delta this call was supposed to leave alone.
      expect(folderCounts(db, BETA)).toEqual({ total: 2, unseen: 1 });
    });
  });
});

describe("task move settlement: putting a refused move back", () => {
  it("clears the goal, latches the selection and brings the rows back into the source view once", () => {
    withMigrated((db) => {
      // The two flags are set here rather than read from the snapshot so the
      // arithmetic is this test's: one message is unread when it leaves and one is
      // not, and the states must be the ones the derived unread count reports.
      setFlags(db, "fx-beta-inbox-4", []);
      setFlags(db, "fx-beta-inbox-3", ["\\Seen"]);
      const task = moveTask(db, SINGLE_ACCOUNT_MOVE);
      // The precondition, asserted rather than assumed: two of the four are already
      // filed under their goal, so the Inbox holds the other two.
      expect(folderCounts(db, BETA)).toEqual({ total: 2, unseen: 1 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 2, unseen: 1 });

      const ids = pendingMoveItemIds(db, task);
      expect(ids).toEqual(["fx-beta-inbox-4", "fx-beta-inbox-3"]);
      // Both refused, and both goals go. `reverted` counts the goals that were
      // actually there to clear while `latched` counts the selection rows taken out
      // of play; here the two agree because this is the single-executor case. The
      // *badges* move for a different reason than they used to: not because a
      // counter was handed back, but because clearing the goal puts the row back in
      // the source view.
      expect(revertMoveFailures(db, task, ids)).toEqual({ reverted: 2, latched: 2 });

      expect(goalOf(db, "fx-beta-inbox-4")).toEqual(NO_GOAL);
      expect(goalOf(db, "fx-beta-inbox-3")).toEqual(NO_GOAL);
      expect(itemOf(db, SINGLE_ACCOUNT_MOVE, "fx-beta-inbox-4").failed).toBe(1);
      expect(itemOf(db, SINGLE_ACCOUNT_MOVE, "fx-beta-inbox-3").failed).toBe(1);
      // All four read in the Inbox again, and the unread pair is the two the flags
      // say are unread -- the unread state a departure took away cannot be restored
      // separately from the placement, because it is the same rows.
      expect(folderCounts(db, BETA)).toEqual({ total: 4, unseen: 2 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 0, unseen: 0 });

      // Idempotent by the latch, not by the caller: a second give-up (a retry that
      // exhausts, a startup sweep) must not run the clear twice. There is no count
      // left for a second clear to double, but the goals must stay cleared and the
      // selection must stay latched.
      expect(revertMoveFailures(db, task, ids)).toEqual({ reverted: 0, latched: 0 });
      expect(folderCounts(db, BETA)).toEqual({ total: 4, unseen: 2 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 0, unseen: 0 });
    });
  });

  it("latches a selection row whose message is gone, leaving the placement alone", () => {
    withMigrated((db) => {
      setFlags(db, "fx-beta-inbox-4", []);
      const task = moveTask(db, SINGLE_ACCOUNT_MOVE);
      // The ids are named here because that is the real sequence: the revert is
      // handed the list it read earlier, and the user deletes the message in
      // between. Reading them again *after* the delete would find nothing (the
      // query joins `messages`), which is not the same question.
      const ids = ["fx-beta-inbox-4"];
      // Literal rather than a snapshot taken just before the revert: the numbers
      // are the placement of the fixture's rows, and comparing against a value
      // read moments earlier would also pass with the comparison moved after the
      // call. Two rows read in the Inbox (`-1` seen, `-2` unread) and two under
      // their Archive goal (`-3` seen, `-4` unread).
      expect(folderCounts(db, BETA)).toEqual({ total: 2, unseen: 1 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 2, unseen: 1 });
      db.prepare("DELETE FROM messages WHERE id = ?").run("fx-beta-inbox-4");

      expect(revertMoveFailures(db, task, ids)).toEqual({ reverted: 0, latched: 1 });
      // The selection must stop claiming it -- otherwise the row is owed forever
      // by a task that can no longer do anything about it. `latched` is where
      // that shows, and it is the reason the two counts are reported separately:
      // the task owes this id no longer, even though the row was never in flight.
      expect(itemOf(db, SINGLE_ACCOUNT_MOVE, "fx-beta-inbox-4").failed).toBe(1);
      // The delete is the only thing that moved a badge here, and it moved the
      // Archive one: `reverted` is 0 because the goal had already been settled by
      // the confirm, so the row was never the revert's to bring back. A count the
      // revert cannot see is a count it cannot get wrong.
      expect(folderCounts(db, BETA)).toEqual({ total: 2, unseen: 1 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 1, unseen: 0 });
    });
  });

  it("leaves a claimed message's placement and goal to sync, whichever state claimed it", () => {
    withMigrated((db) => {
      // The two states a refusal can meet on a row it was told to give back. An
      // `intent` is a MOVE command in flight; a `confirmed` row is one the
      // reconcile has already proven arrived, and it is the `intent` arm of
      // `effective_mailbox` that puts the badge back at the source for the
      // duration -- nothing writes a count on either side of that, so a revert
      // that cleared the goal would be choosing an outcome the provider still
      // owns. The goal therefore survives, because the goal clear's own guard
      // requires a NULL state: that is the difference between "given back" and
      // "someone else owns the outcome", and it is what sync resolves next.
      const task = moveTask(db, SINGLE_ACCOUNT_MOVE);
      setGoal(db, "fx-beta-inbox-4", "Archive", "confirmed");
      setGoal(db, "fx-beta-inbox-3", "Archive", "intent");
      // `-3` in flight reads in the Inbox again, so the split is three there and
      // one under the arrived goal.
      expect(folderCounts(db, BETA)).toEqual({ total: 3, unseen: 1 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 1, unseen: 1 });

      expect(revertMoveFailures(db, task, ["fx-beta-inbox-4", "fx-beta-inbox-3"])).toEqual({ reverted: 0, latched: 2 });
      expect(folderCounts(db, BETA)).toEqual({ total: 3, unseen: 1 });
      expect(folderCounts(db, BETA, "Archive")).toEqual({ total: 1, unseen: 1 });
      // The selection does stop claiming them: the caller refused them, so this
      // task has no work left either way -- and that is the half the runner
      // reports as the task's failure count, which is exactly why "handed back"
      // and "latched" must not be the same number.
      expect(itemOf(db, SINGLE_ACCOUNT_MOVE, "fx-beta-inbox-4").failed).toBe(1);
      expect(itemOf(db, SINGLE_ACCOUNT_MOVE, "fx-beta-inbox-3").failed).toBe(1);
      expect(goalOf(db, "fx-beta-inbox-4")).toEqual({
        destination: "Archive",
        state: "confirmed",
        specialUse: "\\Archive",
        candidateUid: null,
      });
      expect(goalOf(db, "fx-beta-inbox-3")).toEqual({
        destination: "Archive",
        state: "intent",
        specialUse: "\\Archive",
        candidateUid: null,
      });
    });
  });
});

const MOVE_PATH = fileURLToPath(new URL("../src/tasks/kinds/move.ts", import.meta.url));

/** Source with block and line comments removed. §8 G15: a comment mentioning a
 * thing is not doing it, so the negative assertions below must not be satisfied
 * by this module's own prose. */
function strippedSource(): string {
  return fs.readFileSync(MOVE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** One top-level function from the stripped source, to the next top-level one. */
function functionSource(name: string): string {
  const source = strippedSource();
  const start = source.indexOf(`export function ${name}`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  // Every marker that can *end* a top-level declaration, not just the two this
  // file happens to use today: a helper written as an arrow const between the
  // named exports would otherwise be swallowed into the slice above it, silently
  // widening what the per-function assertions read. Indented ones cannot match --
  // the markers are anchored at column 0.
  const next = ["\nexport function ", "\nfunction ", "\nasync function ", "\nconst "]
    .map((marker) => rest.indexOf(marker))
    .filter((index) => index >= 0);
  const end = start + 1 + (next.length ? Math.min(...next) : rest.length);
  return source.slice(start, end);
}

/**
 * The module's direction, asserted from the source rather than from a run.
 *
 * The tests above prove behaviour against the *post-migration* database, which
 * means they cannot see the module reaching back into a table that migration
 * dropped -- they would simply start throwing "no such table" the first time a
 * real settling move ran. So the legaciness is pinned directly: this file must
 * name `task_items` and must not name any of the three dropped stores, which is
 * the §8 G13 precedent (a regex proves the shape, and the shape is what a
 * careless edit destroys).
 */
describe("task move settlement: the port names only the tables that outlive the migration", () => {
  it("reads the selection from task_items and names no legacy store", () => {
    const source = strippedSource();
    // Positive control first: a strip that removed too much, or a path that read
    // nothing, would make the negative below pass for the wrong reason.
    expect(source).toMatch(/task_items/);
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).not.toMatch(/operation_queue|batch_jobs|batch_job_messages/);
    // The port renames the column, so the legacy spelling appearing in *code*
    // (as opposed to the header's account of the port) would mean a row was never
    // renamed at all.
    expect(source).not.toMatch(/job_id/);
  });

  it("asks the question with one prepared statement over the task row it was handed", () => {
    const pending = functionSource("pendingMoveItemIds");
    expect(pending.match(/\.prepare\(/g) ?? []).toHaveLength(1);
    expect(pending).toMatch(/FROM\s+task_items\s+AS\s+b/i);
    expect(pending).toMatch(/JOIN\s+messages\s+AS\s+m/i);
    // Bounded by the task and its account, never by a name from the payload.
    expect(pending).toMatch(/b\.task_id\s*=\s*\?/i);
    expect(pending).toMatch(/m\.account_id\s*=\s*\?/i);
    // Selection order, which is what makes the chunked lookup deterministic and
    // therefore what makes a resumed retry send the same order again.
    expect(pending).toMatch(/ORDER\s+BY\s+b\.rowid/i);
    // The resume-not-replay condition, and the claim clause that keeps an id in
    // the provider's hands out of the next attempt.
    expect(pending).toMatch(/m\.pending_move_state\s+IS\s+NULL/i);
    expect(pending).toMatch(/m\.pending_move_destination\s*=\s*b\.destination_mailbox/i);
    // No mailbox test: arrival is why the goal is gone, not a fact of its own.
    // Written tolerantly because the bypass that matters is a *respelling* --
    // `m."mailbox"` reads the same column -- and the second assertion says the
    // message alias is never quoted at all, which is the spelling this repo's SQL
    // is written in.
    expect(pending).not.toMatch(/\bm\s*\.\s*"?\s*mailbox/i);
    expect(pending).not.toMatch(/"\s*m\s*"\s*\./i);
  });

  it("writes exactly the selection read and the latch, and no folder at all", () => {
    const revert = functionSource("revertMoveFailures");
    // Two statements *written here*, which is what the count pins: a third one
    // would be this module deciding how to change something rather than asking the
    // shared statements. It is deliberately not "how many statements run" --
    // `statements.rowsByIds` and `statements.clearMoveGoal` issue two more, from
    // `sync-move-statements.ts`, which is where the row arithmetic lives.
    expect(revert.match(/\.prepare\(/g) ?? []).toHaveLength(2);
    expect(revert).toMatch(/SELECT\s+message_id,\s*destination_mailbox\s+FROM\s+task_items/i);
    expect(revert).toMatch(/UPDATE\s+task_items\s+SET\s+failed\s*=\s*1/i);
    // Both statements carry the latch's precondition, so neither can touch a row
    // that a previous give-up already settled.
    expect(revert.match(/changed\s*=\s*1\s+AND\s+failed\s*=\s*0/gi) ?? []).toHaveLength(2);
    // Since batch 3 there is nothing to hand back: clearing the goal *is* the
    // return, because the badge is the placement. What the old assertion pinned --
    // that the revert put the count back through the very statement the acceptance
    // took it with -- is now vacuous, and the property worth pinning is stronger
    // and negative: no statement in this module writes `folders`. The two mentions
    // of the table that remain are both comments (the destination resolution reads
    // it, which is a SELECT), so this reads the module with comments stripped.
    expect(strippedSource()).not.toMatch(/UPDATE\s+folders/i);
    expect(revert).not.toMatch(/folders/i);
  });
});
