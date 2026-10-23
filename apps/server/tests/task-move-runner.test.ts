import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";
import type * as syncModule from "../src/sync.js";

/**
 * The two collaborators that must not be real here, and the reason the split is
 * exactly there: mocking `batchMoveMessages` (or `moveMessagesInOneCommand`)
 * would pin a shape the legacy executor already had and prove nothing about the
 * port. The socket and the background reconcile are the only two things a test
 * cannot have -- one dials Gmail, the other starts a second pass over the same
 * account -- so they are the only two replaced. Everything else is the
 * production object: the scheduler, the registry, `batchMoveMessages`, the move
 * statements, the database.
 */
const { imapClientForAccount, syncAccount, timeline } = vi.hoisted(() => ({
  imapClientForAccount: vi.fn(),
  // Recorded, not just resolved: one test asserts the *order* of the provider
  // commands against the reconcile kick, which is the only observable that tells
  // a kick issued after the last chunk from one issued inside the loop. The
  // parameters are spelled out so the recorded call is the runner's seven
  // arguments -- `mock.calls[0][6]` is the shutdown signal, and a zero-argument
  // mock would typecheck that index out of existence.
  syncAccount: vi.fn(async (
    _db: unknown,
    _masterKey: unknown,
    _accountId: unknown,
    _messageLimit: unknown,
    _accessTokenProvider: unknown,
    _agentEvents: unknown,
    _signal: unknown,
  ) => {
    timeline.push("sync");
  }),
  timeline: [] as string[],
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
import { ServerEventBus, type ServerEvent } from "../src/events.js";
import { MAIL_MOVE_IN_FLIGHT_ERROR, MAILBOX_SYNCING_ERROR } from "../src/message-storage.js";
import {
  ACCOUNT_SYNC_WAIT_MS,
  markAccountMoving,
  markAccountSyncing,
  unmarkAccountMoving,
  unmarkAccountSyncing,
} from "../src/sync-locks.js";
import { createMoveRunner, pendingMoveItemIds, revertMoveFailures, type MoveTaskPayload } from "../src/tasks/kinds/move.js";
import { createTaskRegistry } from "../src/tasks/registry.js";
import { startTaskScheduler } from "../src/tasks/scheduler.js";
import { recordTask, reportTaskProgress, taskItems, taskRow } from "../src/tasks/store.js";
import type { TaskRow } from "../src/tasks/types.js";

/**
 * The `move` runner's execution half: what it sends to the provider, what it
 * reports to the task, and what it leaves behind when it cannot deliver.
 *
 * Six claims carry the port, and each one has a test that fails for its own
 * reason:
 *
 *   1. a delivered message's goal is consumed, its arrival is counted once (never
 *      twice -- the acceptance already took the departure), and the connection is
 *      reused across chunks and handed back once;
 *   2. a refusal the provider is unlikely to repeat is settled *here*: the goal
 *      goes back, the source folder gets its count back, and the selection row
 *      is latched so this task stops owing it;
 *   3. a "wait your turn" refusal settles nothing and fails the attempt --
 *      including the case where the world moved on between two attempts, which
 *      is where "resume, don't replay" is decided (the read, not a carried list);
 *   4. the chunk is the unit of settlement, so an attempt that dies after
 *      delivering some messages keeps their count instead of losing it to an
 *      exception that arrives later;
 *   5. the reconcile of an unconfirmed MOVE is the exception to (4): it is per
 *      attempt and lives on the exit path, so a task's own background pass cannot
 *      refuse its next chunk and a throw cannot skip the kick;
 *   6. the failure count it reports is the latch count, not the length of the list
 *      it handed to the give-back -- a difference only a second executor produces.
 *
 * Only the first and the no-payload test drive the scheduler. The rest call the
 * runner the way the scheduler calls it -- same row, same unsealed payload, same
 * `report` statement -- because the attempts worth pinning are the ones where
 * *something else* changes between them, and the scheduler's retry loop
 * deliberately leaves no window for a test to interleave with.
 */

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const SOURCE = "INBOX";
/** The path `target: "archive"` resolves to, i.e. the `\Archive` folder's path. */
const DESTINATION = "Archive";

// ---------------------------------------------------------------------------
// Fixture: one account, an Inbox of `count` unseen messages, an Archive.
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

function insertMessage(db: DatabaseHandle, id: string, uid: number): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ACCOUNT, SOURCE, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify([]), 0, 0, new Date().toISOString());
}

/**
 * The pre-acceptance world: an empty Archive and `count` messages in the Inbox.
 *
 * The source folder used to start a headroom above its message count
 * so that "the departure was taken once, never twice" stayed falsifiable against a
 * counter that floors at zero. Folders carry no counters now (contract §3.6, I4),
 * and the same mistake would show up as a placement off by one.
 */
function fixture(count: number): { db: DatabaseHandle; ids: string[] } {
  const db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db, SOURCE, "Inbox", "\\Inbox");
  insertFolder(db, DESTINATION, "Archive", "\\Archive");
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `msg-${i}`;
    insertMessage(db, id, i);
    ids.push(id);
  }
  return { db, ids };
}

/**
 * What one move task's acceptance commit leaves behind, spelled out.
 *
 * The acceptance is `acceptMoveTask` (`routes/messages.ts:608`/`:662`,
 * `routes/batch-jobs.ts:90`); this helper writes the same two things it writes --
 * the goal the list projection reads, and one selection row per id -- because a
 * runner test wants one precise, hand-controlled row rather than a whole
 * selection's committed state. `task-move-accept.test.ts` is what drives the real
 * acceptance.
 *
 * It used to take a third step as well, subtracting the departure from the source
 * folder's `total`/`unseen`. There is no counter to subtract from (contract §3.6,
 * I4): writing the goal *is* the departure, because the badge reads
 * `effective_mailbox`, which is the goal while the MOVE is unacknowledged.
 *
 * `payload` is a parameter because the runner has a branch for a task that carries
 * none, and the only way to reach that branch through the scheduler is a row whose
 * sealed payload is NULL -- which is what `recordTask` writes for an absent
 * payload (`store.ts:221`), and what an acceptance interrupted before sealing its
 * payload leaves behind. `null` rather than `undefined` on purpose: an explicit
 * `undefined` argument would trigger the default parameter and seal the very
 * payload the test is trying not to have.
 */
function acceptMove(db: DatabaseHandle, ids: readonly string[], payload: MoveTaskPayload | null = { target: "archive" }): string {
  // The acceptance freezes the UID and the mailbox generation of each id, which
  // is what the runner proves again under the lock (`mailbox-generation.ts`).
  // The real acceptance reads the same pair in `rowsByIds`; this helper spells it
  // out because it writes the rows by hand.
  const accepted = db.prepare(`
    SELECT m.uid AS uid, f.uid_validity AS validity
    FROM messages AS m
    LEFT JOIN folders AS f ON f.account_id = m.account_id AND f.path = m.mailbox
    WHERE m.id = ?
  `);
  const taskId = recordTask(db, MASTER_KEY, {
    accountId: ACCOUNT,
    kind: "move",
    payload: payload ?? undefined,
    items: ids.map((messageId) => {
      const frozen = accepted.get(messageId) as { uid: number; validity: string | null };
      return {
        messageId,
        changed: true,
        originMailbox: SOURCE,
        destinationMailbox: DESTINATION,
        originUid: frozen.uid,
        originUidValidity: frozen.validity,
      };
    }),
  });
  const goal = db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = NULL WHERE id = ?");
  for (const id of ids) goal.run(DESTINATION, id);
  return taskId;
}

/**
 * The two badge numbers of one folder, derived from the messages the way the
 * sidebar derives them (contract §4.5, I4).
 *
 * `effective_mailbox` is the folder a row is *visible* in, and it is the whole of
 * why these numbers are interesting here: an untouched goal files the row under its
 * destination, while the `intent` a claimed goal writes files it back under its
 * source until the provider answers. The predicate is spelled out rather than
 * imported so this stays an independent statement about target state.
 */
const folderCounts = (db: DatabaseHandle, path: string): { total: number; unseen: number } => {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ?").get(ACCOUNT, path) as { n: number }).n;
  const unseen = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND effective_mailbox = ? AND flags_json NOT LIKE '%\\Seen%'").get(ACCOUNT, path) as { n: number }).n;
  return { total, unseen };
};

const messageState = (db: DatabaseHandle, id: string) =>
  db.prepare("SELECT mailbox, pending_move_destination, pending_move_state FROM messages WHERE id = ?").get(id) as {
    mailbox: string;
    pending_move_destination: string | null;
    pending_move_state: string | null;
  };

const itemState = (db: DatabaseHandle, taskId: string, messageId: string) => {
  const item = taskItems(db, taskId).find((row) => row.message_id === messageId);
  expect(item, `${messageId} must be a selection row of ${taskId}`).toBeDefined();
  return item!;
};

// The socket. One client object for the whole file, plus a per-test record of
// every MOVE command it was asked to issue -- the uid list is the sharpest
// evidence of what an attempt did and did not send.
//
// The provider's answer is a flag read inside the implementation rather than a
// `mockResolvedValueOnce`: a once-value *replaces* the implementation for that
// call, so the command that was refused would leave no record and the test would
// be unable to tell "the provider refused it" from "the runner never asked".
const lock = { release: vi.fn() };
const logout = vi.fn(async () => undefined);
const connect = vi.fn(async () => undefined);
let moveCalls: number[][];
/** How the provider answers every MOVE command this test issues. */
let providerAnswer: "deliver" | "refuse" | "lose";
/**
 * A second executor, simulated: whatever this does, it does *while this attempt
 * is at the provider command* -- after the attempt has read the ids it owes and
 * before it settles them, which is the only window in which the interleavings
 * that matter are reachable. Null everywhere it is not wanted, and reset per
 * test, because a leak here would look like a production bug.
 */
let concurrent: (() => void) | null = null;
const messageMove = vi.fn(async (uids: number | number[], destination: string) => {
  const list = Array.isArray(uids) ? uids : [uids];
  moveCalls.push(list);
  timeline.push(`move:${list.length}`);
  concurrent?.();
  if (providerAnswer === "refuse") return undefined;
  // The command was issued and the answer never came back: the ambiguous
  // outcome, not a rejection the caller can attribute to the request.
  if (providerAnswer === "lose") throw new Error("socket closed");
  // A UIDPLUS server answers with the destination UID of every message it moved,
  // which is what makes the move "confirmed" rather than "pending".
  return { path: SOURCE, destination, uidMap: new Map(list.map((uid) => [uid, uid + 1000])) };
});
const client = {
  usable: true,
  // Set by the generation tests: what the selected mailbox reports as its
  // `UIDVALIDITY`. Left `undefined` everywhere else, which the check reads as
  // "this transport does not answer" rather than as a mismatch.
  mailbox: undefined as { uidValidity?: bigint } | undefined,
  connect,
  getMailboxLock: vi.fn(async () => lock),
  messageMove,
  logout,
};

type Deltas = Array<{ updated?: number; failed?: number }>;

/**
 * One attempt, driven the way the scheduler drives it: the claimed row, the
 * unsealed payload, and a `report` that goes through the same statement
 * (`reportTaskProgress`) so the counters asserted below are the task's own.
 *
 * `deltas` is the caller's array rather than a return value, because the
 * attempts that matter most are the ones that throw -- and what they reported
 * before throwing has to survive the exception.
 */
async function attempt(
  db: DatabaseHandle,
  taskId: string,
  deltas: Deltas = [],
  payload: MoveTaskPayload = { target: "archive" },
): Promise<void> {
  const runner = createMoveRunner({ db, masterKey: MASTER_KEY });
  const task = taskRow(db, taskId);
  expect(task, `${taskId} must exist`).toBeDefined();
  await runner({
    task: task as TaskRow,
    payload,
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
  timeline.length = 0;
  providerAnswer = "deliver";
  concurrent = null;
  client.mailbox = undefined;
  // Module-level state in sync-locks: a test that marks an account busy (moving or
  // syncing) must not leave the next one looking at a busy account.
  unmarkAccountMoving(ACCOUNT);
  unmarkAccountSyncing(ACCOUNT);
  imapClientForAccount.mockImplementation(async () => client);
});

afterEach(() => {
  unmarkAccountMoving(ACCOUNT);
  unmarkAccountSyncing(ACCOUNT);
  // A test that drove the 15s sync wait under fake timers must not leave the next
  // one -- or this teardown -- on a mocked clock.
  vi.useRealTimers();
  db?.close();
  vi.restoreAllMocks();
});

describe("task move runner: the happy path through the real scheduler", () => {
  it("delivers every accepted id, counts each arrival once and hands the connection back", async () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, world.ids);
    // The acceptance's own effect, asserted rather than assumed: writing the goal is
    // what empties the source view, before the runner exists and before any MOVE.
    expect(folderCounts(db, SOURCE)).toEqual({ total: 0, unseen: 0 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 3, unseen: 3 });

    const registry = createTaskRegistry();
    const settled: Array<{ id: string; status: string }> = [];
    registry.register("move", createMoveRunner({ db, masterKey: MASTER_KEY }));
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
    for (const id of world.ids) {
      // One command for the whole (account, mailbox) group, and the goal is
      // consumed by the arrival -- both halves of "the message is now in the
      // destination folder" and nothing left behind.
      expect(messageState(db, id)).toEqual({ mailbox: DESTINATION, pending_move_destination: null, pending_move_state: null });
    }
    // Neither badge has moved since the acceptance, and neither could: there is no
    // departure to take once and no arrival to take a second time, only the rows,
    // which the confirm rebinds from the goal to the mailbox column. "Counted once"
    // used to need the fixture's headroom to stay falsifiable; a placement cannot be
    // counted twice in the first place.
    expect(folderCounts(db, SOURCE)).toEqual({ total: 0, unseen: 0 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 3, unseen: 3 });
    expect(moveCalls).toEqual([[1, 2, 3]]);
  });

  it("delivers a folder selection to the path its payload names", async () => {
    const world = fixture(2);
    db = world.db;
    // The acceptance writes the folder form; the runner is handed the same
    // payload the scheduler unseals from the row. The socket is the only fake.
    const taskId = acceptMove(db, world.ids, { folderPath: DESTINATION });
    const deltas: Deltas = [];

    await attempt(db, taskId, deltas, { folderPath: DESTINATION });

    expect(moveCalls).toEqual([[1, 2]]);
    expect(deltas).toEqual([{ updated: 2, failed: 0 }]);
    for (const id of world.ids) {
      expect(messageState(db, id)).toEqual({ mailbox: DESTINATION, pending_move_destination: null, pending_move_state: null });
    }
  });
});

describe("task move runner: a message the provider will not take", () => {
  it("gives the goal and the source count back, latches the selection and counts it failed", async () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1", "msg-2"]);
    expect(folderCounts(db, SOURCE)).toEqual({ total: 1, unseen: 1 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 2, unseen: 2 });

    // The provider refuses the whole message set: every claimed intent is
    // dropped, and the failure text is not one of the two account-level ones, so
    // this task has to settle it rather than retry it.
    providerAnswer = "refuse";
    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ updated: 0, failed: 2 }]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "pending", updated: 0, failed: 2 });
    for (const id of ["msg-1", "msg-2"]) {
      // Back in the source view: the goal is what hides it, so clearing it is the
      // whole of "the message reappears".
      expect(messageState(db, id)).toEqual({ mailbox: SOURCE, pending_move_destination: null, pending_move_state: null });
      expect(itemState(db, taskId, id).failed).toBe(1);
    }
    // The goals go back and the rows follow them: all three read in the source view
    // again, and the Archive is empty -- the pre-acceptance placement exactly. The
    // refund is one fact now, "the goal is gone", instead of a counter that had to be
    // handed back by hand.
    expect(folderCounts(db, SOURCE)).toEqual({ total: 3, unseen: 3 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 0, unseen: 0 });
    expect(moveCalls).toEqual([[1, 2]]);
    // Nothing is owed any more, so a second attempt has nothing to send.
    expect(pendingMoveItemIds(db, taskRow(db, taskId) as TaskRow)).toEqual([]);
  });

  it("settles a task that carries no destination as failed on the first attempt", async () => {
    const world = fixture(1);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1"], null);
    // A payload that is missing now will be missing on attempt eight too, so the
    // runner names the terminal state itself instead of letting the scheduler
    // retry it. Driven through the real scheduler, because "not retried" is a
    // property of its abort path rather than of this throw: one attempt, one
    // settled row, and the permanent-failure hook -- which is what hands the
    // account's selection back.
    const registry = createTaskRegistry();
    const settled: Array<{ id: string; status: string }> = [];
    const abandoned: Array<{ id: string; status: string }> = [];
    registry.register("move", createMoveRunner({ db, masterKey: MASTER_KEY }));
    const scheduler = startTaskScheduler({
      db,
      masterKey: MASTER_KEY,
      registry,
      hooks: {
        onTaskSettled: (task: TaskRow) => settled.push({ id: task.id, status: task.status }),
        onTaskPermanentFailure: (task: TaskRow) => abandoned.push({ id: task.id, status: task.status }),
      },
      dueTickMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    scheduler.start(taskId);
    await scheduler.drain();
    await scheduler.stop();

    expect(settled).toEqual([{ id: taskId, status: "failed" }]);
    expect(abandoned).toEqual([{ id: taskId, status: "failed" }]);
    // The code survives to the row, so the reason an operator sees is the
    // runner's own verdict rather than a generic provider failure
    // (`settleTask` writes `error_code`, `store.ts:364`).
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "no_payload", updated: 0, failed: 0 });
    // It threw before the read, so nothing was sent and nothing was given back:
    // the goal is untouched and the selection is still owed -- giving it back is
    // the hook's job, not a job this runner does on its way out.
    expect(messageState(db, "msg-1")).toEqual({ mailbox: SOURCE, pending_move_destination: DESTINATION, pending_move_state: null });
    expect(moveCalls).toEqual([]);
  });
});

describe("task move runner: a refusal that is about the account, not the message", () => {
  it("settles nothing, reports zeros and fails the attempt so the scheduler can retry it", async () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1"]);
    expect(folderCounts(db, SOURCE)).toEqual({ total: 2, unseen: 2 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 1, unseen: 1 });

    markAccountMoving(ACCOUNT);
    const deltas: Deltas = [];
    await expect(attempt(db, taskId, deltas)).rejects.toThrow(MAIL_MOVE_IN_FLIGHT_ERROR);

    // Nothing was delivered and nothing was given back: giving a "wait your turn"
    // message back would only make the list flicker while the goal comes right
    // back on the retry.
    expect(deltas).toEqual([{ updated: 0, failed: 0 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 0, failed: 0 });
    expect(messageState(db, "msg-1")).toEqual({ mailbox: SOURCE, pending_move_destination: DESTINATION, pending_move_state: null });
    expect(itemState(db, taskId, "msg-1").failed).toBe(0);
    expect(folderCounts(db, SOURCE)).toEqual({ total: 2, unseen: 2 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 1, unseen: 1 });
    // No MOVE command was issued at all, and the connection the attempt opened
    // was still handed back -- the release is in a `finally` for this path.
    expect(moveCalls).toEqual([]);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("treats a running sync pass as 'wait your turn' rather than as a give-up", async () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1", "msg-2"]);
    expect(folderCounts(db, SOURCE)).toEqual({ total: 1, unseen: 1 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 2, unseen: 2 });

    // The other half of the retryable set, and the half with a real cost: a pass
    // that outlives this write's patience has to leave the goals alone and fail the
    // attempt, or a bulk move would hand its whole selection back every time the
    // account happened to be syncing. The 15s budget is driven by fake timers --
    // what is pinned is the classification on the far side of it, not the duration.
    markAccountSyncing(ACCOUNT);
    vi.useFakeTimers();
    const deltas: Deltas = [];
    const pending = attempt(db, taskId, deltas);
    const rejection = expect(pending).rejects.toThrow(MAILBOX_SYNCING_ERROR);
    await vi.advanceTimersByTimeAsync(ACCOUNT_SYNC_WAIT_MS + 1_000);
    await rejection;
    vi.useRealTimers();
    unmarkAccountSyncing(ACCOUNT);

    expect(deltas).toEqual([{ updated: 0, failed: 0 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 0, failed: 0 });
    for (const id of ["msg-1", "msg-2"]) {
      expect(messageState(db, id)).toEqual({ mailbox: SOURCE, pending_move_destination: DESTINATION, pending_move_state: null });
      expect(itemState(db, taskId, id).failed).toBe(0);
    }
    expect(folderCounts(db, SOURCE)).toEqual({ total: 1, unseen: 1 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 2, unseen: 2 });
    // The provider was never asked -- the guard is checked before any command --
    // and the connection the attempt opened was still handed back.
    expect(moveCalls).toEqual([]);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("resumes from the read instead of replaying when the world moved on between attempts", async () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1", "msg-2"]);
    const task = taskRow(db, taskId) as TaskRow;
    expect(pendingMoveItemIds(db, task)).toEqual(["msg-1", "msg-2"]);

    // Attempt one meets a busy account and sends nothing.
    markAccountMoving(ACCOUNT);
    await expect(attempt(db, taskId)).rejects.toThrow(MAIL_MOVE_IN_FLIGHT_ERROR);
    unmarkAccountMoving(ACCOUNT);

    // What another executor (or sync's reconcile) does to a row it has proven
    // arrived: the mailbox is rewritten and the goal goes. That is the whole
    // write now -- there is no arrival to count separately, because the row has
    // already read in the destination view since the acceptance wrote its goal.
    db.prepare("UPDATE messages SET mailbox = ?, pending_move_destination = NULL, pending_move_state = NULL WHERE id = ?").run(DESTINATION, "msg-1");

    // This is the whole of "resume, not replay": the next attempt's work list is
    // a read of what the task still owes, so the delivered id is gone from it
    // before any provider command is considered.
    expect(pendingMoveItemIds(db, task)).toEqual(["msg-2"]);

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);
    expect(moveCalls).toEqual([[2]]);
    expect(deltas).toEqual([{ updated: 1, failed: 0 }]);
    // The id that was already delivered is not counted a second time, and the one
    // this attempt delivered is.
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 0 });
    expect(messageState(db, "msg-2")).toEqual({ mailbox: DESTINATION, pending_move_destination: null, pending_move_state: null });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 2, unseen: 2 });
  });
});

describe("task move runner: the chunk is the unit of settlement", () => {
  it("counts an ambiguous transport failure as delivered and hands the row to sync", async () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1"]);
    expect(folderCounts(db, SOURCE)).toEqual({ total: 2, unseen: 2 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 1, unseen: 1 });

    // The command was issued and the answer never arrived. The move may or may
    // not have happened, so nothing is given back and the count goes up: the
    // message is out of this task's hands either way, and sync's reconcile is
    // what settles whether it arrived.
    providerAnswer = "lose";
    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ updated: 1, failed: 0 }]);
    expect(messageState(db, "msg-1")).toEqual({ mailbox: SOURCE, pending_move_destination: DESTINATION, pending_move_state: "intent" });
    expect(itemState(db, taskId, "msg-1").failed).toBe(0);
    // No arrival is counted -- the answer never came, so nothing is knowable about
    // one. But the source view gains the row back, and that is the `intent` arm of
    // `effective_mailbox` doing its job: a claimed goal reads at the row's own
    // mailbox until the provider answers, so an unacknowledged MOVE puts the message
    // back in the Inbox badge and the Inbox list together.
    expect(folderCounts(db, SOURCE)).toEqual({ total: 3, unseen: 3 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 0, unseen: 0 });
    // The reconcile is kicked for the account, in the background, with the same
    // master key and access-token provider the runner was built with. All seven
    // positions are named because the last one is the shutdown signal, which this
    // runner was built without (§0.4 十五 ②): `syncAccount`'s signal is
    // positional and optional, so "no signal" is an explicit `undefined` slot
    // rather than an absent argument.
    expect(syncAccount).toHaveBeenCalledWith(db, MASTER_KEY, ACCOUNT, expect.any(Number), undefined, undefined, undefined);
    // A claimed row is out of the next read, so no retry can send it again even
    // though its goal is still there.
    expect(pendingMoveItemIds(db, taskRow(db, taskId) as TaskRow)).toEqual([]);
  });

  it("reports each chunk as it lands, so a selection larger than one chunk settles incrementally", async () => {
    // 101 ids: one full chunk and one straggler. The boundary is not decoration --
    // it is what a long task's progress counter advances on, and the number
    // itself is pinned here rather than exported, because a test that read the
    // constant could not notice it changing.
    const world = fixture(101);
    db = world.db;
    const taskId = acceptMove(db, world.ids);

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(moveCalls.map((uids) => uids.length)).toEqual([100, 1]);
    // In selection order, which is what makes a chunked lookup deterministic and
    // therefore what makes a resumed retry send the same order again.
    expect(moveCalls[0]![0]).toBe(1);
    expect(moveCalls[0]![99]).toBe(100);
    expect(moveCalls[1]).toEqual([101]);
    // Two reports, not one: the progress a user sees after the first chunk is
    // durable before the second chunk is attempted.
    expect(deltas).toEqual([{ updated: 100, failed: 0 }, { updated: 1, failed: 0 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 101, failed: 0 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 101, unseen: 101 });
    // Two chunks, one connection, one hang-up: this is the only test in the file
    // where those counts can tell a reused socket from a per-chunk re-dial, since
    // a single-chunk attempt dials once either way.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe("task move runner: the background reconcile is per attempt, not per chunk", () => {
  it("kicks it once, after the last chunk", async () => {
    // Every chunk loses its answer here, so both of them ask for a reconcile of
    // the same account -- and the *order* is the assertion. A kick issued after
    // chunk one would start a pass on the account, and this task's own next chunk
    // would then wait on that pass (`isAccountSyncing` ->
    // `waitForAccountSyncIdle`, 15s) and be refused with `MAILBOX_SYNCING_ERROR`
    // for as long as it runs: a task manufacturing a retryable failure for itself,
    // on exactly the accounts that produce a kick at all (no UIDPLUS, or a lost
    // response). One kick for the attempt is also what keeps the cost flat -- 400
    // chunks are still one reconcile.
    const world = fixture(101);
    db = world.db;
    const taskId = acceptMove(db, world.ids);
    providerAnswer = "lose";

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(timeline).toEqual(["move:100", "move:1", "sync"]);
    expect(syncAccount).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual([{ updated: 100, failed: 0 }, { updated: 1, failed: 0 }]);
  });

  it("hands the pass the shutdown signal and publishes mail.synced when it finishes", async () => {
    // The two things the runner gained with the routes' switch, and neither is
    // decoration. The signal: the route that used to start this pass handed it
    // `context.syncShutdownSignal`, and process shutdown -- not a client
    // navigating away -- is what may interrupt a pass whose whole purpose is to
    // verify a goal that is already committed. The event: `events.ts` names "move
    // reconciliation" as one of `mail.synced`'s senders, and the renderer's move
    // confirmation rides exactly that event (`realtimeSync` maps it to its
    // refresh, which is what resolves `pendingArchiveMoves`) -- so a runner that
    // reconciled silently would leave the message looking unconfirmed for as long
    // as the poll interval (§0.4 十五 ①②).
    const world = fixture(1);
    db = world.db;
    const taskId = acceptMove(db, world.ids);
    providerAnswer = "lose";
    // `emitAccountSynced` reads the account's last pass and emits nothing without
    // one, which is the same guard that keeps a never-synced account from
    // publishing a timestamp it does not have.
    db.prepare("UPDATE accounts SET last_synced_at = ? WHERE id = ?").run(new Date().toISOString(), ACCOUNT);

    const controller = new AbortController();
    const bus = new ServerEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((event) => { events.push(event); });
    await createMoveRunner({
      db,
      masterKey: MASTER_KEY,
      syncAbortSignal: controller.signal,
      serverEvents: bus,
    })({
      task: taskRow(db, taskId) as TaskRow,
      payload: { target: "archive" },
      items: taskItems(db, taskId),
      signal: new AbortController().signal,
      report: (delta) => { reportTaskProgress(db, taskId, delta, Date.now()); },
    });

    expect(syncAccount).toHaveBeenCalledTimes(1);
    expect(syncAccount.mock.calls[0]?.[6]).toBe(controller.signal);
    // The event is published after the pass resolves, not when it is kicked.
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 10_000 });
    expect(events[0]).toMatchObject({ type: "mail.synced", payload: { accountId: ACCOUNT } });
  });
});

describe("task move runner: the give-back reports what it latched", () => {
  it("does not count an id another executor latched first", async () => {
    // The interleaving the settlement port is built around, simulated where it is
    // actually reachable: while this attempt is at the provider command -- after it
    // read the ids it owes and before it settles them -- another executor gives
    // msg-2 back (that is `revertMoveFailures` itself: the scheduler settles an
    // abandoned attempt's task `failed`, and the permanent-failure hook hands the
    // ids it still owes to this same function). The provider then refuses this
    // attempt's whole message set, so both ids come back as failures -- but only
    // msg-1 is this attempt's to count. Reporting the length of the list instead
    // would put a row another path already counted into `tasks.failed`.
    const world = fixture(3);
    db = world.db;
    const taskId = acceptMove(db, ["msg-1", "msg-2"]);
    expect(folderCounts(db, SOURCE)).toEqual({ total: 1, unseen: 1 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 2, unseen: 2 });
    concurrent = () => {
      revertMoveFailures(db, taskRow(db, taskId) as TaskRow, ["msg-2"]);
    };
    providerAnswer = "refuse";

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ updated: 0, failed: 1 }]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 0, failed: 1 });
    expect(itemState(db, taskId, "msg-1").failed).toBe(1);
    expect(itemState(db, taskId, "msg-2").failed).toBe(1);
    // Both messages are back in the source view with no goal left. The asymmetry
    // this test is about lives in `deltas` and in the item rows above -- only msg-1
    // was this attempt's to count -- and no longer in a badge: there is nothing left
    // for the badge to drift from, because it is the rows. The old assertion read
    // one *above* the messages the reader could see there, which was the drift the
    // compatibility alias had to project rather than read (contract §4.7 B2).
    expect(folderCounts(db, SOURCE)).toEqual({ total: 3, unseen: 3 });
    expect(folderCounts(db, DESTINATION)).toEqual({ total: 0, unseen: 0 });
    for (const id of ["msg-1", "msg-2"]) {
      expect(messageState(db, id)).toEqual({ mailbox: SOURCE, pending_move_destination: null, pending_move_state: null });
    }
    expect(pendingMoveItemIds(db, taskRow(db, taskId) as TaskRow)).toEqual([]);
  });
});

describe("task move runner: the UID generation frozen at acceptance", () => {
  it("refuses ids whose mailbox was rebuilt since, before any MOVE, and kicks a sync", async () => {
    // The audit's scenario: the acceptance froze `(uid, UIDVALIDITY 10)`, the
    // provider then changed the mailbox so the same number names a different
    // message, and every "current" value on both sides agrees anyway. Only the
    // frozen pair can tell; without it the MOVE would land on a stranger.
    const world = fixture(2);
    db = world.db;
    db.prepare("UPDATE folders SET uid_validity = '10' WHERE account_id = ? AND path = ?").run(ACCOUNT, SOURCE);
    const taskId = acceptMove(db, world.ids);
    client.mailbox = { uidValidity: 11n };

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    // Nothing was sent, both ids were latched (not retried) and the goals came
    // back, so the list shows the messages where they still are.
    expect(moveCalls).toEqual([]);
    expect(deltas).toEqual([{ updated: 0, failed: 2 }]);
    expect(itemState(db, taskId, "msg-1").failed).toBe(1);
    expect(itemState(db, taskId, "msg-2").failed).toBe(1);
    for (const id of world.ids) {
      expect(messageState(db, id)).toEqual({ mailbox: SOURCE, pending_move_destination: null, pending_move_state: null });
    }
    expect(pendingMoveItemIds(db, taskRow(db, taskId) as TaskRow)).toEqual([]);
    // The refusal is only fixable by re-learning the folder, so the pass is asked
    // for on the runner's exit path.
    expect(syncAccount).toHaveBeenCalledTimes(1);
    expect(syncAccount).toHaveBeenCalledWith(db, MASTER_KEY, ACCOUNT, expect.any(Number), undefined, undefined, undefined);
  });

  it("accepts the same ids when the live generation matches the frozen one", async () => {
    const world = fixture(2);
    db = world.db;
    db.prepare("UPDATE folders SET uid_validity = '10' WHERE account_id = ? AND path = ?").run(ACCOUNT, SOURCE);
    const taskId = acceptMove(db, world.ids);
    client.mailbox = { uidValidity: 10n };

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(moveCalls).toEqual([[1, 2]]);
    expect(deltas).toEqual([{ updated: 2, failed: 0 }]);
  });
});
