import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { MOVE_LOCATION_UNVERIFIED_ERROR } from "../src/message-storage.js";
import { acceptMoveTask, pendingMoveItemIds, type AcceptMoveInput } from "../src/tasks/kinds/move.js";
import { taskItems, taskRow } from "../src/tasks/store.js";
import type { TaskItemRow } from "../src/tasks/types.js";

/**
 * The `move` acceptance: the one transaction that writes the user's local target
 * state and the tasks that will converge it, for all three entries at once
 * (contract §九 D3).
 *
 * Five claims carry it, and each has a test that fails for its own reason:
 *
 *   1. the goal, the source-folder departure, the task row and its selection are
 *      one commit, and the ids the runner will later read are exactly the ones
 *      the acceptance claimed -- the seam between the two halves, asserted by
 *      running the runner's own read against the acceptance's rows;
 *   2. "already at the destination" and "refused" are two different things that
 *      are both non-work, and `updated + failed == total` from birth: they are
 *      what the opening `reportTaskProgress` buys, and without it a task whose
 *      whole selection was refused reports 0/0 forever;
 *   3. the refusals keep their reasons apart, because the single route and the
 *      explicit batch route answer their callers in different words for them;
 *   4. a job's tasks are named so `GET /api/batch-jobs/:id` can find them: the
 *      bare id for one account, `jobId:accountId` when the selection spans
 *      accounts (§九 D4) -- and a job id carrying that separator is refused, because
 *      the grammar is positional and only this frame knows which string is the root;
 *   5. the guard on the goal write, not the classification above it, is what
 *      stops a row another writer claimed -- including the ids that reached the
 *      classification as movable.
 *
 * The database, the statements and `commitTask` are the production ones. Only the
 * scheduler is a stub, and it has to be: the real one runs the runner, which
 * dials the provider, and nothing about the acceptance needs a socket.
 */

const MASTER_KEY = Buffer.alloc(32, 0x3c);
const ACCOUNT = "acc-1";
const OTHER_ACCOUNT = "acc-2";
const SOURCE = "INBOX";
/** The path `target: "archive"` resolves to, i.e. the `\Archive` folder's path. */
const DESTINATION = "Archive";

/**
 * `noUncheckedIndexedAccess` is on, so a fixture's element reads as `T | undefined`
 * even where the fixture is what guarantees it is there.
 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`expected an element at ${index} of a ${list.length}-element list`);
  return value;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `${id}@example.com`, "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

function insertFolder(db: DatabaseHandle, accountId: string, path: string, specialUse: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(accountId, path, path, specialUse);
}

function insertMessage(db: DatabaseHandle, accountId: string, id: string, mailbox: string, uid: number): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, mailbox, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify(["\\Unseen"]), 0, 0, new Date().toISOString());
}

/**
 * An account with an Inbox and an Archive, and `count` unseen messages in the
 * Inbox.
 *
 * The folders carry no counters of their own (contract §3.6, I4), so this used to
 * seed the source above its message count to keep a doubled departure
 * distinguishable from a balanced pair. There is nothing to depart from now: what
 * the assertions read is {@link counts}, the placement of the rows.
 */
function fixture(count: number, accountId = ACCOUNT): { db: DatabaseHandle; ids: string[] } {
  const db = openDatabase(":memory:");
  insertAccount(db, accountId);
  insertFolder(db, accountId, SOURCE, "\\Inbox");
  insertFolder(db, accountId, DESTINATION, "\\Archive");
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `${accountId}-msg-${i}`;
    insertMessage(db, accountId, id, SOURCE, i);
    ids.push(id);
  }
  return { db, ids };
}

function starter(): { started: string[]; start: (id: string) => void } {
  const started: string[] = [];
  return { started, start: (id: string) => { started.push(id); } };
}

function accept(db: DatabaseHandle, input: AcceptMoveInput) {
  const scheduler = starter();
  return { scheduler, accepted: acceptMoveTask({ db, masterKey: MASTER_KEY, scheduler }, input) };
}

/**
 * The two badge numbers of one folder, derived from the messages the way the
 * sidebar derives them (contract §4.5, I4).
 *
 * `effective_mailbox` is the folder a row is *visible* in, which is what makes this
 * the badge rather than a reading of any column: a row carrying an untouched move
 * goal already reads in its destination view -- the acceptance's whole point -- and
 * a row whose MOVE is in flight reads back at its source until the confirm lands.
 * The predicate is spelled out rather than imported so this stays an independent
 * statement about target state.
 */
const counts = (db: DatabaseHandle, accountId: string, path: string): { total: number; unseen: number } => {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ?").get(accountId, path) as { n: number }).n;
  const unseen = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ? AND flags_json NOT LIKE '%\\Seen%'").get(accountId, path) as { n: number }).n;
  return { total, unseen };
};

const goal = (db: DatabaseHandle, id: string): { destination: string | null; state: string | null } => {
  const row = db.prepare("SELECT pending_move_destination, pending_move_state FROM messages WHERE id = ?").get(id) as {
    pending_move_destination: string | null;
    pending_move_state: string | null;
  };
  return { destination: row.pending_move_destination, state: row.pending_move_state };
};

/** The ids this task will actually send a MOVE for, read through `task_items`. */
const claimed = (items: TaskItemRow[]): string[] =>
  items.filter((item) => item.changed === 1).map((item) => item.message_id);

// ---------------------------------------------------------------------------

describe("move acceptance: local target state and the task that converges it", () => {
  it("commits the goal, the departure, the task and its selection as one, and hands the runner exactly those ids", () => {
    const { db, ids } = fixture(3);
    const { scheduler, accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.updated).toBe(3);
    expect(accepted.delivering).toBe(3);
    expect(accepted.refusals).toEqual([]);
    expect(accepted.destinations.get(ACCOUNT)).toBe(DESTINATION);
    // The message leaves its source view now, without a claim: `intent` is
    // reserved for "a MOVE command may be in flight" and this one has not been
    // issued yet.
    for (const id of ids) expect(goal(db, id)).toEqual({ destination: DESTINATION, state: null });
    // The goal *is* the placement: all three rows leave the Inbox view now, and the
    // Archive view shows them immediately. The old counter took a departure here and
    // deferred the arrival to the confirm; a derived badge has nothing to defer --
    // the same destination the user's list already files them under is the one the
    // badge counts. See contract §4.5 and the note on `effective_mailbox`.
    expect(counts(db, ACCOUNT, SOURCE)).toEqual({ total: 0, unseen: 0 });
    expect(counts(db, ACCOUNT, DESTINATION)).toEqual({ total: 3, unseen: 3 });

    expect(accepted.handles).toHaveLength(1);
    const handle = at(accepted.handles, 0);
    expect(handle.kind).toBe("move");
    // Started after the commit, and once.
    expect(scheduler.started).toEqual([handle.id]);
    const row = taskRow(db, handle.id)!;
    expect(row.status).toBe("pending");
    expect(row.scope).toBe("batch");
    expect(row.total).toBe(3);
    expect(row.updated).toBe(0);
    expect(row.failed).toBe(0);
    expect(claimed(taskItems(db, handle.id))).toEqual(ids);
    // The seam between the halves, run through the runner's own read rather than
    // a restatement of it: everything the acceptance claimed is what the task
    // still owes, and nothing else.
    expect(pendingMoveItemIds(db, row)).toEqual(ids);
  });

  it("counts an already-arrived message as done, writing it no goal and taking no departure", () => {
    const { db, ids } = fixture(1);
    // The user re-archives a message that is already in Archive -- reachable from
    // an All Mail view, where the folder is not what the action targets.
    db.prepare("UPDATE messages SET mailbox = ? WHERE id = ?").run(DESTINATION, at(ids, 0));

    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.updated).toBe(1);
    // Nothing to deliver -- and this is the count the single route reads for
    // `refreshPending`, which is why it cannot be `handles.length`: the task below
    // exists, and still nothing is coming.
    expect(accepted.delivering).toBe(0);
    expect(accepted.refusals).toEqual([]);
    // No goal: there is no work, and a goal here would be a promise nothing
    // would ever resolve.
    expect(goal(db, at(ids, 0))).toEqual({ destination: null, state: null });
    // The row is already in the folder the action targets, so this reads the same
    // before and after: one Archive row, not two. The source assertion that used to
    // sit here -- "the counter did not take a departure" -- has no subject left, as
    // a derived count cannot take one.
    expect(counts(db, ACCOUNT, DESTINATION)).toEqual({ total: 1, unseen: 1 });

    // The two numbers here are the point of the opening report. The task can
    // never deliver anything -- its only row needs no work -- so if the
    // acceptance did not settle it, `total` would be 1 with `updated + failed`
    // stuck at 0, which is the arithmetic the batch-job alias shows the user.
    const row = taskRow(db, at(accepted.handles, 0).id)!;
    expect(row.total).toBe(1);
    expect(row.updated).toBe(1);
    expect(row.failed).toBe(0);
    expect(pendingMoveItemIds(db, row)).toEqual([]);
  });

  it("carries the undo window the caller passes and none when it passes nothing", () => {
    const { db, ids } = fixture(2);
    const withWindow = accept(db, { target: "archive", messageIds: [at(ids, 0)], undoWindowMs: 300_000 });
    expect(taskRow(db, at(withWindow.accepted.handles, 0).id)!.undo_window_ms).toBe(300_000);
    const without = accept(db, { target: "archive", messageIds: [at(ids, 1)] });
    expect(taskRow(db, at(without.accepted.handles, 0).id)!.undo_window_ms).toBeNull();
  });

  it("materializes a repeated id once, so the task's total is reachable", () => {
    const { db, ids } = fixture(1);
    const { accepted } = accept(db, { target: "archive", messageIds: [at(ids, 0), at(ids, 0)] });

    expect(accepted.updated).toBe(1);
    const row = taskRow(db, at(accepted.handles, 0).id)!;
    // `insertTaskItems` is INSERT OR IGNORE: a selection that named the same
    // message twice would hold one row, and a `total` of 2 could never be met.
    expect(row.total).toBe(1);
    expect(taskItems(db, row.id)).toHaveLength(1);
    // Named twice, moved once: the row is in one folder and the other is empty.
    expect({ source: counts(db, ACCOUNT, SOURCE).total, destination: counts(db, ACCOUNT, DESTINATION).total }).toEqual({ source: 0, destination: 1 });
  });
});

describe("move acceptance: what it refuses, and in whose words", () => {
  it("counts an arrived message the provider could not verify as done, where the single path used to refuse it", () => {
    // The state a UIDPLUS-less provider leaves behind on arrival: the mailbox is
    // rewritten to the destination and the state reads 'confirmed', but there is no
    // stable remote id, so `moveActionBlockedError` answers
    // `MOVE_LOCATION_UNVERIFIED_ERROR` for the row. It is genuinely in the target
    // folder, and the goal is therefore already satisfied.
    //
    // The two orders disagree here and only here, which is why this test exists:
    // the single path tests the block first (`sync-moves.ts:189`) and refuses the
    // user's archive of a message that is already archived, while the batch path
    // tests the arrival first (deleted `batch-jobs.ts:676`) and counts it done.
    // This acceptance takes the batch answer for all three entries (contract §九 D5).
    const { db, ids } = fixture(1);
    db.prepare("UPDATE messages SET mailbox = ?, pending_move_destination = ?, pending_move_state = 'confirmed', remote_id_lookup = NULL WHERE id = ?")
      .run(DESTINATION, DESTINATION, at(ids, 0));

    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.updated).toBe(1);
    expect(accepted.refusals).toEqual([]);
    // Nothing is written: the row keeps the confirmed state sync is still working
    // off, and the goal it already has is the one this action asked for.
    expect(goal(db, at(ids, 0))).toEqual({ destination: DESTINATION, state: "confirmed" });
    // Already in the destination view -- that is what "the goal is satisfied" means
    // now -- so the acceptance has nowhere to move it and writes nothing.
    expect({ source: counts(db, ACCOUNT, SOURCE).total, destination: counts(db, ACCOUNT, DESTINATION).total }).toEqual({ source: 0, destination: 1 });
    const row = taskRow(db, at(accepted.handles, 0).id)!;
    expect(row.updated).toBe(1);
    expect(row.failed).toBe(0);
    expect(pendingMoveItemIds(db, row)).toEqual([]);
  });

  it("refuses a message another move owns, without touching its goal", () => {
    const { db, ids } = fixture(1);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = NULL WHERE id = ?").run("Trash", at(ids, 0));

    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.updated).toBe(0);
    expect(accepted.refusals).toEqual([{ id: at(ids, 0), reason: "reconciling" }]);
    // The newer decision wins: this acceptance must not overwrite the destination
    // the row already carries.
    expect(goal(db, at(ids, 0))).toEqual({ destination: "Trash", state: null });
    // Placed in neither folder of this action: the destination the other move had
    // already claimed is where the list and the badge both find it.
    expect({ source: counts(db, ACCOUNT, SOURCE).total, destination: counts(db, ACCOUNT, DESTINATION).total }).toEqual({ source: 0, destination: 0 });
    const row = taskRow(db, at(accepted.handles, 0).id)!;
    expect(row.total).toBe(1);
    expect(row.failed).toBe(1);
    expect(row.updated).toBe(0);
    expect(claimed(taskItems(db, row.id))).toEqual([]);
  });

  it("gives an unverified location its own reason, distinct from a plain pending move", () => {
    // A confirmed arrival whose provider never supplied a stable remote id: it
    // cannot be addressed remotely again until a sync resolves it, and the user
    // is told something different from "another move is in flight"
    // (`MOVE_LOCATION_UNVERIFIED_ERROR` against `PENDING_MOVE_RECONCILIATION_ERROR`).
    const { db, ids } = fixture(1);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = 'confirmed', remote_id_lookup = NULL WHERE id = ?")
      .run(DESTINATION, at(ids, 0));

    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.refusals).toEqual([{ id: at(ids, 0), reason: "location_unverified" }]);
    expect(MOVE_LOCATION_UNVERIFIED_ERROR).toMatch(/未提供可验证的新位置/);
  });

  it("refuses every id of an account with no folder for the target, and still commits one task", () => {
    const { db, ids } = fixture(2);
    db.prepare("DELETE FROM folders WHERE account_id = ? AND path = ?").run(ACCOUNT, DESTINATION);

    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.refusals).toEqual([
      { id: at(ids, 0), reason: "unavailable" },
      { id: at(ids, 1), reason: "unavailable" },
    ]);
    expect(accepted.destinations.has(ACCOUNT)).toBe(false);
    for (const id of ids) expect(goal(db, id)).toEqual({ destination: null, state: null });
    // The slice is still materialized: the ids belong to an account, so they are
    // part of what the user asked for and must add up in the job's progress.
    const row = taskRow(db, at(accepted.handles, 0).id)!;
    expect(row.total).toBe(2);
    expect(row.failed).toBe(2);
    expect(accepted.updated).toBe(0);
  });

  it("refuses an id with no cached row, and counts it in no task", () => {
    const { db, ids } = fixture(1);
    const { accepted } = accept(db, { target: "archive", messageIds: [at(ids, 0), "ghost"] });

    expect(accepted.updated).toBe(1);
    expect(accepted.refusals).toEqual([{ id: "ghost", reason: "not_found" }]);
    // The one refusal with a consequence beyond its own row: `total` is per task,
    // and no account can own an id nothing has a row for. The callers that answer
    // directly report it; a job's progress does not count it (§九 D6).
    expect(taskRow(db, at(accepted.handles, 0).id)!.total).toBe(1);
  });

  it("refuses a row the goal guard rejects, even though the classification passed it as movable", () => {
    // A claimed state with no destination: `moveActionBlockedError` reads a row
    // with no destination as unblocked, and `BEGIN_MOVE_GOAL_SQL` refuses it
    // anyway (`pending_move_state IS NULL` is half its guard). The state is
    // constructed here because reaching it needs a writer between the acceptance's
    // read and its transaction; what is under test is that the guard is the
    // decider, so a row the classification passed cannot be claimed twice.
    const { db, ids } = fixture(1);
    db.prepare("UPDATE messages SET pending_move_destination = NULL, pending_move_state = 'confirmed' WHERE id = ?").run(at(ids, 0));

    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.updated).toBe(0);
    expect(accepted.refusals).toEqual([{ id: at(ids, 0), reason: "claimed" }]);
    expect(goal(db, at(ids, 0))).toEqual({ destination: null, state: "confirmed" });
    // The goal guard refused it, so nothing was written and the row keeps its place
    // in the Inbox view.
    expect(counts(db, ACCOUNT, SOURCE)).toEqual({ total: 1, unseen: 1 });
    const row = taskRow(db, at(accepted.handles, 0).id)!;
    expect(row.failed).toBe(1);
    expect(claimed(taskItems(db, row.id))).toEqual([]);
  });
});

describe("move acceptance: one task per account, named so the job alias can find them", () => {
  it("uses the bare job id when one account owns the selection", () => {
    const { db, ids } = fixture(2);
    const { accepted } = accept(db, { target: "archive", messageIds: ids, jobId: "job-1" });

    expect(accepted.jobId).toBe("job-1");
    expect(accepted.handles.map((handle) => handle.id)).toEqual(["job-1"]);
    // What `GET /api/batch-jobs/:id` resolves a job by, and what `migrate.ts:529`
    // writes for a migrated one: the prefix group is the alias.
    const grouped = db.prepare("SELECT id FROM tasks WHERE id = ? OR id LIKE ?").pluck().all("job-1", "job-1:%");
    expect(grouped).toEqual(["job-1"]);
  });

  it("names each task after the account when the selection spans accounts", () => {
    const { db, ids } = fixture(1);
    insertAccount(db, OTHER_ACCOUNT);
    insertFolder(db, OTHER_ACCOUNT, SOURCE, "\\Inbox");
    insertFolder(db, OTHER_ACCOUNT, DESTINATION, "\\Archive");
    const other = `${OTHER_ACCOUNT}-msg-1`;
    insertMessage(db, OTHER_ACCOUNT, other, SOURCE, 1);

    const { scheduler, accepted } = accept(db, { target: "archive", messageIds: [at(ids, 0), other], jobId: "job-1" });

    expect(accepted.handles.map((handle) => handle.id)).toEqual(["job-1:acc-1", "job-1:acc-2"]);
    expect(scheduler.started).toEqual(["job-1:acc-1", "job-1:acc-2"]);
    // One task per account, each carrying only its own slice: the runner's read
    // is scoped to `m.account_id = ?`, so a task holding another account's ids
    // would never deliver them.
    expect(taskRow(db, "job-1:acc-1")!.total).toBe(1);
    expect(taskRow(db, "job-1:acc-2")!.total).toBe(1);
    expect(pendingMoveItemIds(db, taskRow(db, "job-1:acc-1")!)).toEqual([at(ids, 0)]);
    expect(pendingMoveItemIds(db, taskRow(db, "job-1:acc-2")!)).toEqual([other]);
    expect(goal(db, at(ids, 0)).destination).toBe(DESTINATION);
    expect(goal(db, other).destination).toBe(DESTINATION);
    // The way the alias aggregates: the prefix group, which for a cross-account
    // job is every row (the bare id is not a row of its own).
    const grouped = db.prepare("SELECT account_id FROM tasks WHERE id LIKE ? ORDER BY id").pluck().all("job-1:%");
    expect(grouped).toEqual([ACCOUNT, OTHER_ACCOUNT]);
  });

  it("leaves the ids unnamed when no caller supplied a job", () => {
    const { db, ids } = fixture(1);
    const { accepted } = accept(db, { target: "archive", messageIds: ids });

    expect(accepted.jobId).toBeNull();
    expect(at(accepted.handles, 0).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a job id that carries the separator the alias groups by", () => {
    // The alias finds a job's members by splitting an id at the first colon
    // (`jobs.ts`'s `rootJobId`), and the grammar is positional: a root of its own
    // containing a colon makes `job-1:2` and a member of `job-1` the same string, so
    // no reader can separate the two jobs. This is the last frame that knows which
    // string is the root, and it is refused before any row exists -- `/api/batch-jobs`
    // never takes a job id from the wire, so no caller reaches it by accident.
    const { db, ids } = fixture(1);
    expect(() => accept(db, { target: "archive", messageIds: ids, jobId: "job-1:acc-2" }))
      .toThrow(/colon-free/);
    expect(() => accept(db, { target: "archive", messageIds: ids, jobId: "" })).toThrow(/colon-free/);
    expect(db.prepare("SELECT COUNT(*) FROM tasks").pluck().get()).toBe(0);
  });
});
