import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";
import type * as syncModule from "../src/sync.js";

/**
 * The `undo` runner: which messages it restores, which it refuses to touch, and
 * what it does with the ones it cannot restore.
 *
 * The socket is the only collaborator replaced. Everything else is the production
 * object: `commitUndoTask` writes the very task the runner runs (so the
 * acceptance's row and the runner's expectations cannot drift apart),
 * `moveMessageToFolder` brings its intent claim, its UIDPLUS confirm and its folder
 * accounting, and the scheduler, registry and folder counters are the real ones.
 * Mocking the move would pin a shape this runner is supposed to inherit unchanged
 * and prove nothing about it.
 *
 * Seven claims carry the runner, each with a test that fails on its own:
 *
 *   1. every entry goes back to *its own* origin -- one task, three messages, two
 *      origins -- and the arrival is confirmed through the real UIDPLUS path;
 *   2. an entry that is already back, and one the user has re-moved since, are
 *      counted `updated` without a provider call: the newer decision wins (legacy
 *      `runUndo`, `batch-jobs.ts:1097-1105`, deleted);
 *   3. an entry whose move state is claimed is settled *nowhere* -- neither counted
 *      nor latched -- and fails the attempt so the retry finds it (§4.7 A (v18)④: a
 *      `confirmed` row keeps `mailbox` reading its source while its effective folder
 *      is the destination, so "already back" would be a lie);
 *   4. an entry that settles does so before a later refusal is raised, which is why
 *      the refusal is thrown after the loop rather than where it is met;
 *   5. a refusal the provider is unlikely to repeat is latched here, and the socket
 *      it went through is dropped so the next entry dials a fresh one;
 *   6. an entry naming a message this cache no longer has is latched too -- no retry
 *      can create the row -- and only once;
 *   7. the permanent-failure latch closes the arithmetic: `updated + failed` reaches
 *      `total` for a task the scheduler gives up on, and a second call adds nothing;
 *   8. a retryable refusal keeps the connection open, so the entries after it ride the
 *      socket it left behind rather than dialling again (what a single-entry task
 *      cannot show: one dial either way);
 *   9. a failure the provider reports is counted `failed` only when the goal does not
 *      hold *now*: a message that got home by another path while the command was in
 *      flight is counted `updated`, and the socket is still dropped.
 */

const { imapClientForAccount, syncAccount } = vi.hoisted(() => ({
  imapClientForAccount: vi.fn(),
  // The pass a refused generation asks for. Recorded rather than real: a test
  // cannot dial the provider, and the runner's contract is only that it asks.
  syncAccount: vi.fn(async () => undefined),
}));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncModule>();
  return { ...actual, syncAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { MAIL_MOVE_IN_FLIGHT_ERROR, MOVE_LOCATION_UNVERIFIED_ERROR, PENDING_MOVE_RECONCILIATION_ERROR } from "../src/message-storage.js";
import { markAccountMoving, unmarkAccountMoving } from "../src/sync-locks.js";
import { commitUndoTask, createUndoRunner, failPendingUndoItems, type UndoTaskPayload } from "../src/tasks/kinds/undo.js";
import { createTaskRegistry } from "../src/tasks/registry.js";
import { startTaskScheduler } from "../src/tasks/scheduler.js";
import { openTaskPayload, recordTask, reportTaskProgress, settleTask, taskItems, taskRow } from "../src/tasks/store.js";
import { TASK_UNDO_WINDOW_MS, type TaskRow } from "../src/tasks/types.js";

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const INBOX = "INBOX";
/** Where the forward move put the messages: the folder the undo takes them out of. */
const ARCHIVE = "Archive";
const TRASH = "Trash";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ACCOUNT, "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

function insertFolder(db: DatabaseHandle, path: string, name: string, specialUse: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(ACCOUNT, path, name, specialUse);
}

/**
 * One cached message.
 *
 * This used to bump the folder's counters too, seeding the "balanced pair" a
 * restore's departure and arrival were supposed to leave behind. There is no counter
 * left to seed (contract §3.6, I4) -- the badge *is* {@link heldIn} -- so the fixture
 * only has to put the row where it says the row is.
 */
function seedMessage(db: DatabaseHandle, id: string, uid: number, mailbox: string): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ACCOUNT, mailbox, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify([]), 0, 0, new Date().toISOString());
}

/** An account with the three folders and no messages yet. */
function openFixture(): DatabaseHandle {
  const db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db, INBOX, "Inbox", "\\Inbox");
  insertFolder(db, ARCHIVE, "Archive", "\\Archive");
  insertFolder(db, TRASH, "Trash", "\\Trash");
  return db;
}

/**
 * The forward move's own task, settled and undoable.
 *
 * Built with `recordTask`/`settleTask` rather than through `acceptMoveTask`,
 * because an undo test wants the forward row's numbers chosen by hand -- the
 * completion the window is measured from, the selection the reverse walks --
 * instead of whatever a whole selection's commit happens to produce; the same
 * choice `task-undo.test.ts`'s `moveParent` makes. Everything the undo reads off
 * this row -- `changed`, `origin_mailbox`, `status`, `completed_at`,
 * `undo_window_ms` -- is written here the way that acceptance writes it.
 */
function moveParent(db: DatabaseHandle, ids: ReadonlyArray<{ id: string; origin: string }>): string {
  const id = recordTask(db, MASTER_KEY, {
    accountId: ACCOUNT,
    kind: "move",
    scope: "batch",
    payload: { target: "archive" },
    undoWindowMs: TASK_UNDO_WINDOW_MS,
    items: ids.map(({ id: messageId, origin }) => ({ messageId, changed: true, originMailbox: origin, destinationMailbox: ARCHIVE })),
  });
  settleTask(db, id, "completed", null, Date.now());
  return id;
}

/**
 * The undo task, committed by the acceptance the route will call.
 *
 * Deliberately not a hand-written row: the point of this file is the runner, and a
 * runner test that builds its own row cannot notice the acceptance handing it
 * something unrunnable (a scope, an item set, a payload spelling). `start()` goes to a
 * no-op starter because these tests drive the chain themselves -- `drain` for the one
 * test that wants the scheduler, `attempt` for the ones that want to interleave with
 * an attempt.
 */
function acceptUndo(db: DatabaseHandle, parentId: string): string {
  const outcome = commitUndoTask({ db, masterKey: MASTER_KEY, scheduler: { start: () => undefined } }, parentId);
  expect(outcome.ok, `the undo of ${parentId} must be accepted: ${JSON.stringify(outcome)}`).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  expect(outcome.taskIds).toHaveLength(1);
  return outcome.taskIds[0]!;
}

const messageState = (db: DatabaseHandle, id: string) =>
  db.prepare("SELECT mailbox, uid, pending_move_destination, pending_move_state FROM messages WHERE id = ?").get(id) as {
    mailbox: string;
    uid: number;
    pending_move_destination: string | null;
    pending_move_state: string | null;
  };

const itemState = (db: DatabaseHandle, taskId: string, messageId: string) => {
  const item = taskItems(db, taskId).find((row) => row.message_id === messageId);
  expect(item, `${messageId} must be a selection row of ${taskId}`).toBeDefined();
  return item!;
};

/**
 * How many messages are filed in one folder, read the way the sidebar badge is.
 *
 * `effective_mailbox` is the folder a row is *visible* in -- a move that is still in
 * flight counts at its source -- so this is the number the badge shows, not the raw
 * `mailbox` column. These assertions used to read the folder's own counter, seeded
 * with a headroom so that a doubled departure would stand out from a balanced pair.
 * There is no counter now (contract §3.6, I4): the rows are the badge, and the same
 * doubled departure shows up as a placement that is off by one.
 */
const heldIn = (db: DatabaseHandle, path: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ?").get(ACCOUNT, path) as { n: number }).n;

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

const lock = { release: vi.fn() };
const connect = vi.fn(async () => undefined);
const logout = vi.fn(async () => undefined);
let moveCalls: Array<{ uid: number; destination: string }>;
/**
 * Whether the next mailbox-lock request dies. A throw here happens after the intent
 * is claimed and before any MOVE command is issued, so `moveMessageCore` clears the
 * intent and rethrows (`sync-moves.ts:504-511`) -- a transport failure whose message
 * says nothing about the request, and the reason the socket is dropped.
 */
let lockFails = false;
const getMailboxLock = vi.fn(async () => {
  if (lockFails) {
    lockFails = false;
    throw new Error("socket closed");
  }
  return lock;
});
const messageMove = vi.fn(async (uids: number | number[], destination: string) => {
  const uid = Array.isArray(uids) ? uids[0]! : uids;
  moveCalls.push({ uid, destination });
  // A UIDPLUS server answers with the destination UID of what it moved; that is what
  // makes the restore "confirmed" rather than "pending", and the rewritten `uid` on
  // the row is the evidence this went through the real confirm statement.
  return { path: INBOX, destination, uidMap: new Map([[uid, uid + 5_000]]) };
});
const client = {
  usable: true,
  // Set by the generation test: what the selected mailbox reports as its
  // `UIDVALIDITY`. Left `undefined` everywhere else, which the check reads as
  // "this transport does not answer" rather than as a mismatch.
  mailbox: undefined as { uidValidity?: bigint } | undefined,
  connect,
  getMailboxLock,
  messageMove,
  logout,
};

type Deltas = Array<{ updated?: number; failed?: number }>;

/**
 * One attempt, driven the way the scheduler drives it: the row, its unsealed payload,
 * its selection rows, and a `report` that goes through the task's own statement.
 *
 * The undo reports **per entry** -- it settles one message at a time, so one entry is
 * one delta -- which is why the assertions below read the delta list rather than an
 * aggregate out of it.
 */
async function attempt(db: DatabaseHandle, taskId: string, deltas: Deltas = []): Promise<void> {
  const runner = createUndoRunner({ db, masterKey: MASTER_KEY });
  const task = taskRow(db, taskId) as TaskRow;
  await runner({
    task,
    payload: openTaskPayload<UndoTaskPayload>(MASTER_KEY, task),
    items: taskItems(db, taskId),
    signal: new AbortController().signal,
    report: (delta) => {
      deltas.push(delta);
      reportTaskProgress(db, taskId, delta, Date.now());
    },
  });
}

let db: DatabaseHandle;

beforeEach(() => {
  vi.clearAllMocks();
  moveCalls = [];
  lockFails = false;
  client.mailbox = undefined;
  // Module-level state in sync-locks: a test that marks the account busy must not
  // leave the next one looking at a busy account.
  unmarkAccountMoving(ACCOUNT);
  imapClientForAccount.mockImplementation(async () => client);
});

afterEach(() => {
  unmarkAccountMoving(ACCOUNT);
  db?.close();
  vi.restoreAllMocks();
});

describe("task undo runner: restoring a move", () => {
  it("puts every message back where it came from, counted once each", async () => {
    db = openFixture();
    for (const [index, id] of ["msg-1", "msg-2", "msg-3"].entries()) seedMessage(db, id, index + 1, ARCHIVE);
    // Two origins in one selection: msg-3 was archived out of the Trash. A single
    // symbolic target could not name both, which is why the reverse is a task of its
    // own kind rather than a second `move` task.
    const parent = moveParent(db, [
      { id: "msg-1", origin: INBOX },
      { id: "msg-2", origin: INBOX },
      { id: "msg-3", origin: TRASH },
    ]);
    const taskId = acceptUndo(db, parent);
    expect(taskRow(db, taskId)).toMatchObject({ kind: "undo", scope: "batch", total: 3, parent_id: parent, undo_window_ms: null, undone: 0 });
    // The acceptance writes no goal and takes no departure, so the rows are still
    // where they were -- and it is the restore that moves them.
    expect({ inbox: heldIn(db, INBOX), archive: heldIn(db, ARCHIVE), trash: heldIn(db, TRASH) })
      .toEqual({ inbox: 0, archive: 3, trash: 0 });

    const registry = createTaskRegistry();
    const settled: Array<{ id: string; status: string }> = [];
    registry.register("undo", createUndoRunner({ db, masterKey: MASTER_KEY }));
    const scheduler = startTaskScheduler({
      db,
      masterKey: MASTER_KEY,
      registry,
      hooks: { onTaskSettled: (task: TaskRow) => settled.push({ id: task.id, status: task.status }) },
      dueTickMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    scheduler.start(taskId);
    await scheduler.drain();
    await scheduler.stop();

    expect(settled).toEqual([{ id: taskId, status: "completed" }]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", updated: 3, failed: 0 });
    // Each message is back at its own origin, with the goal the provider command
    // claimed consumed and the UIDPLUS destination UID written -- 5001/5002/5003 are
    // the uids the fake server answered with, so this is evidence the real confirm
    // statement ran rather than a column that happens to look right.
    expect(messageState(db, "msg-1")).toEqual({ mailbox: INBOX, uid: 5_001, pending_move_destination: null, pending_move_state: null });
    expect(messageState(db, "msg-2")).toEqual({ mailbox: INBOX, uid: 5_002, pending_move_destination: null, pending_move_state: null });
    expect(messageState(db, "msg-3")).toEqual({ mailbox: TRASH, uid: 5_003, pending_move_destination: null, pending_move_state: null });
    // One MOVE per entry, each addressed at that entry's own origin, in selection
    // order.
    expect(moveCalls).toEqual([
      { uid: 1, destination: INBOX },
      { uid: 2, destination: INBOX },
      { uid: 3, destination: TRASH },
    ]);
    // Both halves of the accounting are the rows themselves now: Archive lost all
    // three, Inbox and Trash gained their arrivals. Placements, so a doubled departure
    // reads as an off-by-one here instead of hiding inside a counter.
    expect({ inbox: heldIn(db, INBOX), archive: heldIn(db, ARCHIVE), trash: heldIn(db, TRASH) })
      .toEqual({ inbox: 2, archive: 0, trash: 1 });
    // One dial and one hang-up for the whole task: the property the shared connection
    // exists for (`batch-jobs.ts:150-156`, deleted, measured the per-message
    // alternative at ~27 minutes of dialling for 400 entries).
    expect(connect).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("counts an entry that is already back, and one the user re-moved since, without calling the provider", async () => {
    db = openFixture();
    // msg-1 never left (or a sync already put it back); msg-2 was moved on by the user
    // after the forward task ran.
    seedMessage(db, "msg-1", 1, INBOX);
    seedMessage(db, "msg-2", 2, TRASH);
    const parent = moveParent(db, [
      { id: "msg-1", origin: INBOX },
      { id: "msg-2", origin: INBOX },
    ]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ updated: 1 }, { updated: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 2, failed: 0 });
    // Neither entry needed the provider, so nothing was dialled at all -- a task that
    // settles entirely on local reads must not pay for a connection.
    expect(moveCalls).toEqual([]);
    expect(imapClientForAccount).not.toHaveBeenCalled();
    // msg-2 stays in the Trash: the newer decision wins, and the undo records that it
    // is done rather than dragging the message back.
    expect(messageState(db, "msg-2")).toMatchObject({ mailbox: TRASH, pending_move_destination: null });
    expect(itemState(db, taskId, "msg-2").changed).toBe(0);
    // Nothing was latched, so a retry still reads both entries as owed -- harmless
    // here, where both settle the same way again, and exactly the shape that must not
    // be reachable for a *failed* entry (see the two tests below).
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 0, failed: 0 });
  });
});

describe("task undo runner: an entry whose move is owned by sync", () => {
  it("settles nothing for it and fails the attempt, because its column cannot be read", async () => {
    db = openFixture();
    // A move the provider confirmed and no sync pass has reconciled yet: `mailbox`
    // still reads INBOX while the effective folder is Archive, so the row *looks* like
    // it is at its origin and is not.
    seedMessage(db, "msg-1", 1, INBOX);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = 'confirmed', remote_id_lookup = ? WHERE id = ?")
      .run(ARCHIVE, "lookup-1", "msg-1");
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);

    // Not one number moved. Counting this `updated` is the outcome §4.7 A (v18)④
    // exists to prevent: it tells the user 已撤销 while the message stays in Archive
    // until the reconcile lands.
    expect(deltas).toEqual([]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "pending", updated: 0, failed: 0 });
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 0 });
    expect(moveCalls).toEqual([]);
    expect(imapClientForAccount).not.toHaveBeenCalled();
  });

  it("waits rather than latches when a newer move on the message is still unclaimed", async () => {
    // The shape the runner's own `pending_move_state` guard cannot see: a destination
    // with no state, i.e. a goal someone wrote and no worker has claimed yet. The
    // guard is silent, so the refusal comes from `moveMessageToFolder` -- and it has to
    // be read as "wait", not as "this message is lost". The newer decision is live: it
    // will land, and what the retry wants is to re-read the row then.
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = NULL WHERE id = ?").run(TRASH, "msg-1");
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);

    expect(deltas).toEqual([]);
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 0 });
    // The goal is not this task's to touch: the undo restores a message, it does not
    // call off somebody else's write (`CLEAR_MOVE_GOAL_SQL` belongs to the task that
    // wrote the goal). Its own departure is not taken either -- nothing was sent.
    expect(messageState(db, "msg-1")).toEqual({ mailbox: ARCHIVE, uid: 1, pending_move_destination: TRASH, pending_move_state: null });
    expect(moveCalls).toEqual([]);
  });

  it("waits when the row turns unverified while the connection is being dialled", async () => {
    // The other member of the superset, and the only way to reach it: the read above
    // said "not claimed", and the yield at the dial is where another executor can make
    // it unverifiable -- sync reconciling a move it cannot name a location for. The
    // refusal then arrives from `moveMessageToFolder`'s guard rather than from this
    // runner's, and it is the same "wait" the two sync-owned texts always mean.
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    imapClientForAccount.mockImplementationOnce(async () => {
      db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = 'confirmed', remote_id_lookup = NULL WHERE id = ?").run(ARCHIVE, "msg-1");
      return client;
    });

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(MOVE_LOCATION_UNVERIFIED_ERROR);

    expect(deltas).toEqual([]);
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 0 });
    // No MOVE was issued, and the socket is kept -- a retryable refusal is evidence
    // about the account's state, not about the connection -- so the release is the only
    // hang-up.
    expect(moveCalls).toEqual([]);
    expect(imapClientForAccount).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection for the entries that come after a retryable refusal", async () => {
    // The test above asserts "one dial, one hang-up" for a single-entry task, and that
    // assertion cannot tell *keeping* the connection from dropping it: a task whose
    // only entry ends the attempt dials once either way. A second entry that still
    // needs the provider separates the two readings -- keeping the socket means its
    // MOVE rides the connection the refusal went through, dropping it means a second
    // dial. Reuse is the entire reason the connection is shared
    // (`batch-jobs.ts:150-156`, deleted), so it needs a test that can fail.
    db = openFixture();
    // msg-1 refuses retryably from `moveMessageToFolder` (a destination with no state:
    // the runner's own guard is silent, the shape of the test above), msg-2 restores
    // normally.
    seedMessage(db, "msg-1", 1, ARCHIVE);
    seedMessage(db, "msg-2", 2, ARCHIVE);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = NULL WHERE id = ?").run(TRASH, "msg-1");
    const parent = moveParent(db, [
      { id: "msg-1", origin: INBOX },
      { id: "msg-2", origin: INBOX },
    ]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);

    // One number for the entry that settled, none for the one that refused, and one
    // connection behind both: the dial, the connect and the hang-up are all the count
    // of a single shared session.
    expect(deltas).toEqual([{ updated: 1 }]);
    expect(itemState(db, taskId, "msg-2")).toMatchObject({ changed: 0, failed: 0 });
    expect(moveCalls).toEqual([{ uid: 2, destination: INBOX }]);
    expect(imapClientForAccount).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("keeps what it already settled when a later entry refuses", async () => {
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    // msg-2 reads as being at its origin -- and a MOVE into Archive is in flight for
    // it, so it is not at its origin at all.
    seedMessage(db, "msg-2", 2, INBOX);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = 'intent' WHERE id = ?").run(ARCHIVE, "msg-2");
    const parent = moveParent(db, [
      { id: "msg-1", origin: INBOX },
      { id: "msg-2", origin: INBOX },
    ]);
    const taskId = acceptUndo(db, parent);

    // A refusal fails the attempt, and a failed attempt is retried -- so what this
    // pins is the settlement that must survive the throw. msg-1 settled before the
    // refusal was met, and it is `finally` that keeps it: a rollback would have taken
    // it back and left the retry re-restoring a message that is already home.
    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);

    expect(deltas).toEqual([{ updated: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 0 });
    expect(messageState(db, "msg-1")).toMatchObject({ mailbox: INBOX, pending_move_state: null });
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 0, failed: 0 });
    expect(itemState(db, taskId, "msg-2")).toMatchObject({ changed: 1, failed: 0 });
    // The one command this attempt issued, before it met the refusal.
    expect(moveCalls).toEqual([{ uid: 1, destination: INBOX }]);

    // Once sync has reconciled the claimed row, the retry settles it -- and only it,
    // which is the "resume, don't replay" half of the same design.
    db.prepare("UPDATE messages SET mailbox = ?, pending_move_destination = NULL, pending_move_state = NULL WHERE id = ?").run(ARCHIVE, "msg-2");
    await attempt(db, taskId, deltas);
    expect(deltas).toEqual([{ updated: 1 }, { updated: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 2, failed: 0 });
    // msg-1's command is not issued a second time: its row is latched, so the retry's
    // read no longer owes it.
    expect(moveCalls).toEqual([
      { uid: 1, destination: INBOX },
      { uid: 2, destination: INBOX },
    ]);
  });

  it("settles the entries a refusal came before, because the refusal waits its turn", async () => {
    // The same two entries as the test above, in the other order -- and the order is
    // the whole assertion. A refusal raised *where it is met* would abandon the
    // attempt before reaching msg-2, deferring a message it could have restored to a
    // retry that nothing schedules at a moment of its choosing; raised after the loop,
    // it fails the attempt with the restore already done. Which is why "the ids a
    // refusal left behind, and only those" is a claim about the *read*, not about
    // stopping early.
    db = openFixture();
    seedMessage(db, "msg-1", 1, INBOX);
    seedMessage(db, "msg-2", 2, ARCHIVE);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = 'intent' WHERE id = ?").run(ARCHIVE, "msg-1");
    const parent = moveParent(db, [
      { id: "msg-1", origin: INBOX },
      { id: "msg-2", origin: INBOX },
    ]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);

    // msg-2 was restored by the attempt that refused msg-1, and the entry that refused
    // is still owed exactly as it was.
    expect(deltas).toEqual([{ updated: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 0 });
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 0 });
    expect(itemState(db, taskId, "msg-2")).toMatchObject({ changed: 0, failed: 0 });
    expect(messageState(db, "msg-2")).toMatchObject({ mailbox: INBOX, uid: 5_002 });
    expect(moveCalls).toEqual([{ uid: 2, destination: INBOX }]);
  });
});

describe("task undo runner: an entry the provider will not take", () => {
  it("latches a restore with nowhere to go as failed, and drops the socket it went through", async () => {
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    seedMessage(db, "msg-2", 2, ARCHIVE);
    // msg-1's origin folder is gone from the cache: the restore has nowhere to go and
    // no retry can bring the folder back. Unlike the two "wait" cases above, this one
    // ends the entry.
    const parent = moveParent(db, [
      { id: "msg-1", origin: "Gone" },
      { id: "msg-2", origin: INBOX },
    ]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    // Settled here rather than retried: the second entry was restored in the same
    // attempt, which a path that gave up at the first failure would not do.
    expect(deltas).toEqual([{ failed: 1 }, { updated: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 1 });
    expect(itemState(db, taskId, "msg-1").failed).toBe(1);
    expect(itemState(db, taskId, "msg-2").changed).toBe(0);
    expect(messageState(db, "msg-2")).toMatchObject({ mailbox: INBOX, uid: 5_002 });
    // msg-1 is exactly where it was: a failed restore invents nothing. Only the
    // message that actually moved left the Archive -- read off the rows, which is what
    // a floor under a counter used to be able to hide.
    expect(messageState(db, "msg-1")).toMatchObject({ mailbox: ARCHIVE, uid: 1, pending_move_destination: null });
    expect({ inbox: heldIn(db, INBOX), archive: heldIn(db, ARCHIVE), trash: heldIn(db, TRASH) })
      .toEqual({ inbox: 1, archive: 1, trash: 0 });
    // The socket the failed entry used was dropped rather than reused, so the second
    // entry dialled again -- one hang-up for the corpse (the invalidate) plus one for
    // the fresh connection (the release).
    expect(imapClientForAccount).toHaveBeenCalledTimes(2);
    expect(logout).toHaveBeenCalledTimes(2);
  });

  it("counts a restore the provider refused as done when the message got home anyway", async () => {
    // What the provider reports is evidence about the *command*, not about where the
    // message is now: another path -- the user's own move, sync's reconcile -- can put
    // the message back while this command is failing, and then the undo's goal holds
    // although nothing this task sent was accepted. Counting `failed` there tells the
    // user a message was not restored while it sits at its origin, which is the lie
    // §4.7 A ④ refuses in the other direction. The flip is inside the *pre-command*
    // failure, so no MOVE is issued and the row's new state cannot be mistaken for the
    // reconciliation of one -- which is why the pre-guard above still sees the
    // destination and only the settlement's re-read can notice.
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    getMailboxLock.mockImplementationOnce(async () => {
      db.prepare("UPDATE messages SET mailbox = ?, pending_move_destination = NULL, pending_move_state = NULL WHERE id = ?").run(INBOX, "msg-1");
      throw new Error("socket closed");
    });

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ updated: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 0 });
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 0, failed: 0 });
    expect(moveCalls).toEqual([]);
    // The socket still goes: the failure reached the provider's connection, so a
    // corpse cannot be ruled out. Only the count changes.
    expect(logout).toHaveBeenCalledTimes(1);
    // No badge assertion here on purpose: the fixture is what moved the row, standing
    // in for whatever else did, so the folder counters have no reason to follow. The
    // count is the subject.
  });

  it("waits, and drops the socket, when the transport dies after the command was issued", async () => {
    // The one failure that arrives as a *value* rather than as a throw: a transport
    // failure after MOVE was issued leaves the intent claimed and hands the question to
    // sync's reconcile (`sync-moves.ts:504-511`). Counting that `updated` would report
    // a restore nobody can prove -- and this runner's own first guard refuses to read
    // exactly that row shape when another executor leaves it, so the honest answer is
    // the same "wait". The socket goes, because unlike the four refusal texts this
    // failure was at the transport.
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    messageMove.mockImplementationOnce(async () => {
      throw new Error("Connection not available");
    });

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);

    expect(deltas).toEqual([]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "pending", updated: 0, failed: 0 });
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 0 });
    // The intent stays claimed, and that is what the retry reads: only sync's reconcile
    // clears it, and whichever way it resolves, the entry is still owed here.
    expect(messageState(db, "msg-1")).toMatchObject({ mailbox: ARCHIVE, pending_move_destination: INBOX, pending_move_state: "intent" });
    expect(imapClientForAccount).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("latches a socket that died before the command, leaving the intent it claimed cleared", async () => {
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    lockFails = true;

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    // The provider never confirmed anything, and no guard calls this retryable, so the
    // entry ends here and the failure is the only count.
    expect(deltas).toEqual([{ failed: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 0, failed: 1 });
    // The intent the command claimed went with it: `moveMessageCore` clears it on the
    // not-attempted path, so nothing is left claiming this message is on its way
    // somewhere.
    expect(messageState(db, "msg-1")).toEqual({ mailbox: ARCHIVE, uid: 1, pending_move_destination: null, pending_move_state: null });
    expect(moveCalls).toEqual([]);
    // One hang-up: the invalidate's. There is no second dial -- the task is done -- and
    // so no second connection to release.
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("latches an entry whose message left the cache, and counts it only once", async () => {
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    // A delete, or a re-sync that dropped the row: whatever the cause, the entry names
    // a message this cache no longer has, and no retry can produce it.
    db.prepare("DELETE FROM messages WHERE id = ?").run("msg-1");

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ failed: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 0, failed: 1 });
    expect(itemState(db, taskId, "msg-1").failed).toBe(1);
    expect(moveCalls).toEqual([]);
  });
});

describe("task undo runner: a refusal that is about the account, not the message", () => {
  it("settles nothing, reports nothing and hands the connection back", async () => {
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    // The account-level pair is the move kind's retryable set, and the undo inherits
    // it: the account is busy, which says nothing about this message.
    markAccountMoving(ACCOUNT);

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(MAIL_MOVE_IN_FLIGHT_ERROR);

    // Nothing was sent and nothing was counted: latching here would make a bulk undo
    // give up on every message whenever the account happened to be busy.
    expect(deltas).toEqual([]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "pending", updated: 0, failed: 0 });
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 0 });
    expect(messageState(db, "msg-1")).toMatchObject({ mailbox: ARCHIVE, pending_move_destination: null });
    expect(moveCalls).toEqual([]);
    // The connection the attempt opened was still hung up: the release is in a
    // `finally` for exactly this path.
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe("task undo runner: the permanent-failure latch", () => {
  it("closes the arithmetic when the scheduler gives up on the task", async () => {
    db = openFixture();
    seedMessage(db, "msg-1", 1, ARCHIVE);
    seedMessage(db, "msg-2", 2, INBOX);
    db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = 'intent' WHERE id = ?").run(ARCHIVE, "msg-2");
    const parent = moveParent(db, [
      { id: "msg-1", origin: INBOX },
      { id: "msg-2", origin: INBOX },
    ]);
    const taskId = acceptUndo(db, parent);

    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);
    // The state the obligation exists for: one entry settled, one entry owed, and a
    // retryable refusal that deliberately counts nothing.
    expect(taskRow(db, taskId)).toMatchObject({ total: 2, updated: 1, failed: 0 });

    // What the hook does when the attempts run out: latch the remainder, and report how
    // many it latched.
    const task = taskRow(db, taskId) as TaskRow;
    const latched = failPendingUndoItems(db, task);
    reportTaskProgress(db, taskId, { failed: latched }, Date.now());

    expect(latched).toBe(1);
    expect(taskRow(db, taskId)).toMatchObject({ total: 2, updated: 1, failed: 1 });
    // Idempotent, so a hook that ran twice cannot count the same entry twice.
    expect(failPendingUndoItems(db, task)).toBe(0);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 1 });
    // The latch is bookkeeping, not a restore: the message is still sync's to
    // reconcile, and its intent is untouched.
    expect(messageState(db, "msg-2")).toMatchObject({ mailbox: INBOX, pending_move_destination: ARCHIVE, pending_move_state: "intent" });
  });
});

describe("task undo runner: the UID generation frozen at acceptance", () => {
  it("refuses an entry whose source mailbox was rebuilt since, before any MOVE, and asks for a sync", async () => {
    db = openFixture();
    // The restore's source is ARCHIVE, so that is the generation the acceptance
    // freezes -- `undoItemSpecs` reads it beside the message row.
    db.prepare("UPDATE folders SET uid_validity = '10' WHERE account_id = ? AND path = ?").run(ACCOUNT, ARCHIVE);
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    // The provider rebuilt the folder: UID 1 is somebody else now.
    client.mailbox = { uidValidity: 11n };

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    // No MOVE was issued. The entry is latched (no retry can re-prove generation
    // 10), reported as failed, and the message is still where it was.
    expect(moveCalls).toEqual([]);
    expect(deltas).toEqual([{ failed: 1 }]);
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 1 });
    expect(messageState(db, "msg-1")).toMatchObject({ mailbox: ARCHIVE, pending_move_destination: null, pending_move_state: null });
    expect(heldIn(db, ARCHIVE)).toBe(1);
    expect(syncAccount).toHaveBeenCalledTimes(1);
  });

  it("restores when the live generation matches the frozen one", async () => {
    db = openFixture();
    db.prepare("UPDATE folders SET uid_validity = '10' WHERE account_id = ? AND path = ?").run(ACCOUNT, ARCHIVE);
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    client.mailbox = { uidValidity: 10n };

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(moveCalls).toEqual([{ uid: 1, destination: INBOX }]);
    expect(deltas).toEqual([{ updated: 1 }]);
    expect(heldIn(db, INBOX)).toBe(1);
    expect(syncAccount).not.toHaveBeenCalled();
  });

  it("refuses an entry whose acceptance froze no generation, even when the cache agrees", async () => {
    // The migrated-row shape: the undo item predates `origin_uid_validity`, so
    // nothing records which epoch ARCHIVE's UID 1 belonged to when the restore was
    // accepted. Cache and provider both reading "10" cannot supply that fact after
    // a rebuild, so the entry must be refused instead of restored.
    db = openFixture();
    db.prepare("UPDATE folders SET uid_validity = '10' WHERE account_id = ? AND path = ?").run(ACCOUNT, ARCHIVE);
    seedMessage(db, "msg-1", 1, ARCHIVE);
    const parent = moveParent(db, [{ id: "msg-1", origin: INBOX }]);
    const taskId = acceptUndo(db, parent);
    db.prepare("UPDATE task_items SET origin_uid_validity = NULL WHERE task_id = ?").run(taskId);
    client.mailbox = { uidValidity: 10n };

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(moveCalls).toEqual([]);
    expect(deltas).toEqual([{ failed: 1 }]);
    expect(itemState(db, taskId, "msg-1")).toMatchObject({ changed: 1, failed: 1 });
    expect(messageState(db, "msg-1")).toMatchObject({ mailbox: ARCHIVE, pending_move_destination: null, pending_move_state: null });
    expect(syncAccount).toHaveBeenCalledTimes(1);
  });
});
