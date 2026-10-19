import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

/**
 * The wiring: which hook fires for which kind and status, and what that hook is
 * obliged to put back.
 *
 * The settlement functions themselves are pinned where they live --
 * `task-settlement.test.ts` for the flags half, `task-move-settlement.test.ts` for
 * the move half. What this file owns is the *mapping* (contract §4.7 C/D step 2)
 * and the two things a mapping can get wrong: running a half on the wrong kind, or
 * running it twice.
 *
 * Twice is the interesting one. `onTaskSettled` fires on every real settlement and
 * `onTaskPermanentFailure` additionally on a give-up (`scheduler.ts:150-151`,
 * `:176`, `:183-186`, `:199-200`, `:232-233`, `:243-244`), so **both fire for one
 * give-up** and the halves have to be kind-disjoint: `flags` settles under
 * `onTaskSettled`, `move` under `onTaskPermanentFailure`. The accounting is where a
 * mistake there would show, so the assertions are equalities (`failed === total`),
 * not "at least". Measured, not assumed: dropping the flags remainder report turns
 * three tests red (the row stops at 0/2), and dropping the move half's kind guard
 * makes a move task latch its one row and *then* add the remainder on top (the row
 * reads `failed: 2` where the latch count is 1). Two mutations that looked like
 * counterexamples on paper changed nothing when run -- deleting the move branch's
 * `return`, and deleting the flags branch's `if` -- because the other guard covers
 * the case, which is the kind of thing only running it tells you.
 *
 * What the arithmetic does NOT pin is a second report of the same remainder: the
 * flags half reads the row back out of the database before subtracting, so a
 * duplicate finds nothing owed and writes nothing. That is deliberate -- it makes
 * the two hooks idempotent together instead of depending on the kinds staying
 * disjoint -- and it too was measured: reporting the remainder from `onTaskSettled`
 * as well leaves this file 12/12 green. "Each hook fires once" is pinned by the
 * counting test, not by the ledger.
 *
 * Three of the claims need a real scheduler, because "the hook is wired" is not
 * something a direct call can show: the flags refusal runs through
 * `createTaskExecution` (the composition production will use), the move give-up
 * through `registerTaskRunners` plus a caller's hooks, and the fire counts through
 * a wrapper around `createTaskHooks`.
 *
 * The one collaborator replaced is the socket. Mocking `pushFlagsRemote` would pin
 * the legacy executor's shape and prove nothing about this port; the client is the
 * only thing a test cannot have.
 */

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { accountById } from "../src/account-store.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { ServerEventBus, type ServerEvent } from "../src/events.js";
import { prepareSubmission } from "../src/outbox.js";
import { writePendingSentRow } from "../src/pending-sent.js";
import { acceptFlagsTask } from "../src/tasks/kinds/flags.js";
import { createTaskRegistry } from "../src/tasks/registry.js";
import { startTaskScheduler } from "../src/tasks/scheduler.js";
import { openTaskPayload, recordTask, reportTaskProgress, taskItems, taskRow } from "../src/tasks/store.js";
import type { TaskHooks, TaskRow, TaskScheduler, TaskSpec } from "../src/tasks/types.js";
import { createTaskExecution, createTaskHooks, registerTaskRunners } from "../src/tasks/wiring.js";

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const INBOX = "INBOX";
const ARCHIVE = "Archive";
const SEEN = "\\Seen";
/** Pinned so the hook's own `updated_at` write is not a second variable in a test
 * about arithmetic. */
const FIXED_NOW = 1_767_225_600_000;

// ---------------------------------------------------------------------------
// The socket: a provider that never confirms a STORE.
// ---------------------------------------------------------------------------

const lock = { release: vi.fn() };
const connect = vi.fn(async () => undefined);
const logout = vi.fn(async () => undefined);
/**
 * The provider's "not confirmed" answer on every call, so a push can never
 * succeed and the scheduler has to exhaust its ladder and give up. That is the
 * only path that reaches the settlement hooks with a non-`completed` status, and
 * therefore the only one that exercises the rollback at all.
 */
const messageFlagsAdd = vi.fn(async () => false);
const messageFlagsRemove = vi.fn(async () => true);
const client = {
  usable: true,
  connect,
  getMailboxLock: vi.fn(async () => lock),
  messageFlagsAdd,
  messageFlagsRemove,
  logout,
};

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

function insertMessage(db: DatabaseHandle, id: string, uid: number, flags: string[] = []): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ACCOUNT, INBOX, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify(flags), 0, 0, new Date().toISOString());
}

/** One account, an Inbox of `count` unseen messages, and an Archive to move into. */
function fixture(count: number): { db: DatabaseHandle; ids: string[] } {
  const db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db, INBOX, "Inbox", "\\Inbox");
  insertFolder(db, ARCHIVE, "Archive", "\\Archive");
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `msg-${i}`;
    insertMessage(db, id, i);
    ids.push(id);
  }
  return { db, ids };
}

const flagState = (db: DatabaseHandle, id: string) =>
  db.prepare("SELECT flags_json, pending_flags_push, pending_flags_base_json FROM messages WHERE id = ?").get(id) as {
    flags_json: string;
    pending_flags_push: number | null;
    pending_flags_base_json: string | null;
  };

/**
 * The unread badge of one folder, derived from `messages`: `folders.unseen` is
 * gone and nothing nudges a counter (contract §3.6, I4). Every message this file
 * inserts is unread, so the derived number equals the row count by construction.
 */
const folderUnseen = (db: DatabaseHandle, path: string = INBOX): number =>
  (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND effective_mailbox = ? AND flags_json NOT LIKE '%\\Seen%'")
    .get(ACCOUNT, path) as { count: number }).count;

const moveGoalOf = (db: DatabaseHandle, id: string): { destination: string | null; state: string | null } =>
  db.prepare("SELECT pending_move_destination AS destination, pending_move_state AS state FROM messages WHERE id = ?").get(id) as {
    destination: string | null;
    state: string | null;
  };

const itemOf = (db: DatabaseHandle, taskId: string, messageId: string) => {
  const item = taskItems(db, taskId).find((row) => row.message_id === messageId);
  expect(item, `${messageId} must be a selection row of ${taskId}`).toBeDefined();
  return item!;
};

/**
 * The real flags acceptance, with a recording starter instead of a scheduler.
 *
 * Used rather than a hand-written marker because the hook's rollback exists
 * against *the acceptance's own shape*: the target in `flags_json`, the pre-patch
 * value in `pending_flags_base_json`, the marker, the unread delta and the sealed
 * payload all have to line up for the assertion "it went back to what it was" to
 * mean anything. Writing those by hand would let the test's idea of the
 * acceptance drift from the acceptance.
 */
function acceptFlags(
  db: DatabaseHandle,
  messageIds: readonly string[],
  patch: { seen?: boolean; flagged?: boolean } = { seen: true },
): string {
  const started: string[] = [];
  const accepted = acceptFlagsTask(
    { db, masterKey: MASTER_KEY, scheduler: { start: (id) => started.push(id) } },
    { messageIds, patch },
  );
  expect(started).toEqual(accepted.handles.map((handle) => handle.id));
  return accepted.handles[0]!.id;
}

/** A `move` task the way an acceptance commits one: the goal on the message and
 * one selection row per id. `payload: null` is the shape whose runner aborts with
 * `no_payload` -- reachable without a socket, and the only give-up that costs no
 * backoff rounds. */
function recordMoveTask(db: DatabaseHandle, ids: readonly string[], payload: { target: string } | null): string {
  const taskId = recordTask(db, MASTER_KEY, {
    accountId: ACCOUNT,
    kind: "move",
    scope: "batch",
    total: ids.length,
    ...(payload ? { payload } : {}),
    items: ids.map((messageId) => ({ messageId, changed: true, originMailbox: INBOX, destinationMailbox: ARCHIVE })),
  });
  const goal = db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = NULL WHERE id = ?");
  for (const id of ids) goal.run(ARCHIVE, id);
  return taskId;
}

// ---------------------------------------------------------------------------
// Driving the hooks
// ---------------------------------------------------------------------------

/** The hooks as production builds them, with one clock. */
const hooksOf = (db: DatabaseHandle) => createTaskHooks({ db, now: () => FIXED_NOW });

/** One settlement, called the way the scheduler calls it: the row with its
 * terminal status already set, and the payload already decrypted. */
function settle(db: DatabaseHandle, taskId: string, status: "completed" | "failed" | "cancelled"): void {
  const task = taskRow(db, taskId) as TaskRow;
  hooksOf(db).onTaskSettled!({ ...task, status }, openTaskPayload(MASTER_KEY, task));
}

/** The give-up, called the way the scheduler calls it (`scheduler.ts:186`). */
function giveUp(db: DatabaseHandle, taskId: string): void {
  hooksOf(db).onTaskPermanentFailure!({ ...(taskRow(db, taskId) as TaskRow), status: "failed" }, undefined);
}

/**
 * The registry and a live scheduler, wired the way `createTaskExecution` wires
 * them, but with the caller's hooks so a test can count the fires.
 *
 * The starter is late-bound for the reason production's cycle needs breaking:
 * `flags` serves its historical payload spelling by **accepting** it, and an
 * acceptance commits tasks, so the runner needs a starter that exists only after
 * the scheduler that holds the registry. `TaskStarter` is a one-method interface
 * for exactly this.
 */
function wired(db: DatabaseHandle, hooks: TaskHooks): TaskScheduler {
  const registry = createTaskRegistry();
  const starter: { start: (id: string) => void } = { start: () => undefined };
  registerTaskRunners(registry, {
    db,
    masterKey: MASTER_KEY,
    starter,
    outboundAttachmentDirectory: "",
    scheduleSentVerification: () => undefined,
  });
  const scheduler = startTaskScheduler({
    db,
    masterKey: MASTER_KEY,
    registry,
    hooks,
    dueTickMs: 60_000,
    retryBaseMs: 1,
    retryMaxMs: 1,
  });
  starter.start = (id) => scheduler.start(id);
  return scheduler;
}

/** The real hooks with the two calls counted, so a test can assert "exactly once"
 * without reading them out of behaviour that happens to be idempotent. */
function countedHooks(db: DatabaseHandle): { hooks: TaskHooks; counts: { settled: number; permanent: number } } {
  const real = hooksOf(db);
  const counts = { settled: 0, permanent: 0 };
  return {
    counts,
    hooks: {
      onTaskSettled: (task, payload) => {
        counts.settled += 1;
        real.onTaskSettled!(task, payload);
      },
      onTaskPermanentFailure: (task, payload) => {
        counts.permanent += 1;
        real.onTaskPermanentFailure!(task, payload);
      },
    },
  };
}

let db: DatabaseHandle | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  imapClientForAccount.mockImplementation(async () => client);
});

afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("task wiring: the flags settlement", () => {
  it("gives a refused target back before it clears the marker", () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptFlags(db, ["msg-1", "msg-2"]);
    // The acceptance's footprint, stated: both targets applied locally, both
    // marked, and the unread badge down by the two that flipped.
    expect(flagState(db, "msg-1")).toMatchObject({ flags_json: JSON.stringify([SEEN]), pending_flags_push: 1 });
    expect(folderUnseen(db)).toBe(1);

    settle(db, taskId, "failed");

    // The target is back and the badge with it -- and this assertion is also the
    // ordering pin: the rollback's own `WHERE pending_flags_push = 1` finds
    // nothing once the markers are cleared (`settlement.ts:200-209`), so a hook
    // that cleared first would leave `flags_json` reading `["\Seen"]` here.
    expect(flagState(db, "msg-1")).toEqual({ flags_json: "[]", pending_flags_push: 0, pending_flags_base_json: null });
    expect(flagState(db, "msg-2")).toEqual({ flags_json: "[]", pending_flags_push: 0, pending_flags_base_json: null });
    expect(folderUnseen(db)).toBe(3);
    // The third message was never part of the push, so its marker stays NULL --
    // a marker with no push behind it is a message whose flags sync skips for
    // good, which is why the hook may only touch ids the payload named.
    expect(flagState(db, "msg-3")).toEqual({ flags_json: "[]", pending_flags_push: null, pending_flags_base_json: null });
  });

  it("keeps what the provider confirmed, and only drops the marker", () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptFlags(db, ["msg-1"]);

    settle(db, taskId, "completed");

    // `completed` is the one terminal status under which every STORE was
    // acknowledged (`pushFlagsRemote` throws on an unconfirmed one), so the
    // local target IS the server's state: rolling it back here would throw away
    // a real change, and the badge would disagree with the message.
    expect(flagState(db, "msg-1")).toMatchObject({ flags_json: JSON.stringify([SEEN]), pending_flags_push: 0 });
    expect(folderUnseen(db)).toBe(2);
  });

  it("gives a cancelled push's target back too", () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptFlags(db, ["msg-1"]);

    settle(db, taskId, "cancelled");

    // The contract's (v24) generalization: a cancelled push delivered nothing
    // either, so a refused target left in place would be read as the server's
    // state for good -- the same failure as `failed`. No runner produces a
    // `cancelled` flags task today, so this pins the judgement rather than a
    // reachable path; it is red under the legacy `status === "failed"` condition.
    expect(flagState(db, "msg-1")).toMatchObject({ flags_json: "[]", pending_flags_push: 0, pending_flags_base_json: null });
    expect(folderUnseen(db)).toBe(3);
  });

  it("leaves a target a newer push still holds", () => {
    const world = fixture(3);
    db = world.db;
    const first = acceptFlags(db, ["msg-1"]);
    // A second push over the same message, with a *different* patch -- repeating
    // `{seen: true}` would be a no-op and commit no task at all
    // (`kinds/flags.ts:191-192`), which would make this test's premise empty.
    const second = acceptFlags(db, ["msg-1"], { flagged: true });
    const held = flagState(db, "msg-1");
    expect(held.pending_flags_push).toBe(1);
    expect(held.flags_json).toBe(JSON.stringify([SEEN, "\\Flagged"]));

    settle(db, first, "failed");

    // The newer push supersedes this one, so both its target and its marker stay:
    // clearing the marker would let `flags_json` be read as the server's state
    // while the second push is still in flight (`CONFIRMED_FLAGS_SQL`,
    // `message-flag-indexes.ts:62`), and restoring this one's baseline would
    // overwrite a decision the user has since made.
    expect(flagState(db, "msg-1")).toEqual(held);
    expect(second).not.toBe(first);
  });

  it("leaves a target whose baseline is missing, and drops the marker", () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptFlags(db, ["msg-1"]);
    // A row from a build that did not record a baseline (the legacy pushes wrote
    // the marker without one). There is nothing trustworthy to restore it to.
    db.prepare("UPDATE messages SET pending_flags_base_json = NULL WHERE id = ?").run("msg-1");

    settle(db, taskId, "failed");

    expect(flagState(db, "msg-1")).toMatchObject({ flags_json: JSON.stringify([SEEN]), pending_flags_push: 0 });
  });

  it("reports the flags remainder on a give-up, and nothing when the row already adds up", () => {
    const world = fixture(3);
    db = world.db;
    const taskId = acceptFlags(db, world.ids);
    expect(taskRow(db, taskId)).toMatchObject({ total: 3, updated: 0, failed: 0 });

    // The path this covers: the scheduler gave up after its last attempt, so no
    // runner is around to report anything, and without this the row stops at
    // 0/3 for ever. Same rule as the send runner's (contract §10.10 ②).
    giveUp(db, taskId);
    expect(taskRow(db, taskId)).toMatchObject({ failed: 3 });

    // Already closed: reporting the difference again would be a second write of
    // a number that was reported once, and the check is the difference rather
    // than a count of entries -- a naive `report({failed: total})` reads 6 here.
    reportTaskProgress(db, taskId, { updated: 3 }, FIXED_NOW);
    giveUp(db, taskId);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 3, failed: 3 });
  });
});

describe("task wiring: the move settlement", () => {
  it("reverts the goals of a given-up move task and reports the latch count", () => {
    const world = fixture(2);
    db = world.db;
    const taskId = recordMoveTask(db, world.ids, { target: "archive" });
    // One row another executor already latched, so this call latches one of the
    // two -- and the number it reports is the latch count, not the length of the
    // list it was handed (`kinds/move.ts:148-154`).
    db.prepare("UPDATE task_items SET failed = 1 WHERE task_id = ? AND message_id = ?").run(taskId, "msg-2");

    giveUp(db, taskId);

    expect(moveGoalOf(db, "msg-1")).toEqual({ destination: null, state: null });
    expect(itemOf(db, taskId, "msg-1").failed).toBe(1);
    expect(itemOf(db, taskId, "msg-2").failed).toBe(1);
    // Exactly the latch count. A wiring that also let the `flags` branch run on
    // this task would add the remainder (`2 - 0 - 1`) on top and read 2 here,
    // which is the kind-disjointness claim in one number.
    expect(taskRow(db, taskId)).toMatchObject({ failed: 1, total: 2 });
  });

  it("does not revert a goal for a settlement that is not a give-up", () => {
    const world = fixture(2);
    db = world.db;
    const taskId = recordMoveTask(db, world.ids, { target: "archive" });
    const task = taskRow(db, taskId) as TaskRow;

    // The move half lives on the give-up hook because its condition *is* "the
    // scheduler gave up". Running it for a settlement would throw away a goal the
    // task may still deliver -- and `onTaskSettled` fires for every settlement.
    hooksOf(db).onTaskSettled!({ ...task, status: "completed" }, openTaskPayload(MASTER_KEY, task));

    expect(moveGoalOf(db, "msg-1")).toEqual({ destination: ARCHIVE, state: null });
    expect(itemOf(db, taskId, "msg-1").failed).toBe(0);
    expect(taskRow(db, taskId)).toMatchObject({ failed: 0 });
  });
});

describe("task wiring: the send settlement", () => {
  /**
   * The acceptance's own pair, written through the acceptance's own writers:
   * `prepareSubmission` for the ledger row and `writePendingSentRow` for the
   * optimistic Sent row. A hand-written INSERT would let this test's idea of the
   * placeholder drift from the marker the hook actually keys on.
   *
   * The row's lifetime is the task's (`pending-sent.ts` ①), and until this
   * describe existed nothing exercised that: no test called
   * `retractPendingSentRow`, so both halves of the hook -- "it retires the row"
   * and "only when the mail did not leave" -- were unpinned.
   */
  function acceptSend(db: DatabaseHandle, idempotencyKey = "key-1"): { taskId: string; placeholderId: string; submissionId: string } {
    // A server without a Sent mailbox gets no placeholder at all
    // (`writePendingSentRow` refuses to claim a folder that does not exist), so
    // the fixture has to have one for this test to have a subject.
    insertFolder(db, "Sent", "Sent", "\\Sent");
    const request = { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [] };
    const prepared = prepareSubmission(db, MASTER_KEY, { accountId: ACCOUNT, accountEmail: "demo@example.com", idempotencyKey, request });
    const account = accountById(db, ACCOUNT);
    if (!account) throw new Error("Account fixture missing.");
    const placeholderId = writePendingSentRow(db, MASTER_KEY, {
      account,
      submissionId: prepared.submission.id,
      rfcMessageId: prepared.submission.messageId,
      request,
      attachments: [],
    });
    if (!placeholderId) throw new Error("The fixture's account has no Sent mailbox.");
    const taskId = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "send",
      total: 1,
      submissionId: prepared.submission.id,
    } satisfies TaskSpec);
    return { taskId, placeholderId, submissionId: prepared.submission.id };
  }

  /** The rows the settlement hook is allowed to remove, read by its own predicate. */
  const placeholdersFor = (db: DatabaseHandle, submissionId: string): string[] =>
    (db.prepare("SELECT id FROM messages WHERE pending_send = ?").all(submissionId) as Array<{ id: string }>).map((row) => row.id);

  it("retires a failed send's optimistic Sent row, and closes its books", () => {
    const world = fixture(1);
    db = world.db;
    const { taskId, placeholderId, submissionId } = acceptSend(db);
    expect(placeholdersFor(db, submissionId)).toEqual([placeholderId]);

    settle(db, taskId, "failed");

    // The row's whole justification is "the user was told it went out"
    // (`pending-sent.ts`), and this task never got past the socket. Left in
    // place, it would show a mail in Sent that no provider holds.
    expect(placeholdersFor(db, submissionId)).toEqual([]);
    // And the books close here rather than in the runner: a failed attempt
    // reports no counts (the attempt that decides is the attempt that counts),
    // so without this remainder the row stops at 0/1 for good.
    expect(taskRow(db, taskId)).toMatchObject({ total: 1, updated: 0, failed: 1 });
  });

  it("keeps a completed send's row, which is the row the claim lands on", () => {
    const world = fixture(1);
    db = world.db;
    const { taskId, placeholderId, submissionId } = acceptSend(db);
    reportTaskProgress(db, taskId, { updated: 1 }, FIXED_NOW);

    settle(db, taskId, "completed");

    // `completed` is the one terminal status under which the SMTP acknowledgement
    // was received, i.e. the mail is in Sent and the user was told the truth.
    // Removing the row here would empty the Sent view of a mail that really went
    // out -- and would take away the row `claimPendingSentRow` re-keys when the
    // provider's copy syncs, leaving two rows for one mail.
    expect(placeholdersFor(db, submissionId)).toEqual([placeholderId]);
    expect(taskRow(db, taskId)).toMatchObject({ updated: 1, failed: 0 });
  });

  it("retires a cancelled send's row too", () => {
    const world = fixture(1);
    db = world.db;
    const { taskId, submissionId } = acceptSend(db);

    settle(db, taskId, "cancelled");

    // Not an exception to the rule: a cancelled send's claim is exactly as false
    // as a failed one's. No runner produces a `cancelled` send task today, so
    // this pins the judgement rather than a reachable path -- and it is red under
    // a `status === "failed"` condition.
    expect(placeholdersFor(db, submissionId)).toEqual([]);
  });
});

describe("task wiring: the registry", () => {
  it("holds every kind this layer implements, snooze included", () => {
    const world = fixture(1);
    db = world.db;
    const registry = createTaskRegistry();
    registerTaskRunners(registry, {
      db,
      masterKey: MASTER_KEY,
      starter: { start: () => undefined },
      outboundAttachmentDirectory: "",
      scheduleSentVerification: () => undefined,
    });

    // Read at runtime rather than off the source: a source-text assertion can
    // only show that a literal exists somewhere in the file, while
    // `registry.get` answers the question the scheduler actually asks. An
    // unregistered kind settles `failed` with `no_runner` having never run
    // anything (`scheduler.ts:141-152`), so a lost registration is silent to
    // every other test in this file.
    //
    // `snooze` was the tripwire here until v40: its routes existed with no
    // runner, and the assertion said so. It is a positive assertion now that
    // `tasks/kinds/snooze.ts` supplies one -- a new kind added without a runner
    // still turns this red, which is what the list is for.
    for (const kind of ["move", "flags", "undo", "send", "snooze"] as const) {
      expect(registry.get(kind), `${kind} must be registered`).toBeDefined();
    }
  });
});

describe("task wiring: a real scheduler", () => {
  it("carries a refused flags push to a settled failure and puts the local state back", async () => {
    const world = fixture(2);
    db = world.db;
    const taskId = acceptFlags(db, world.ids);
    expect(folderUnseen(db)).toBe(0);

    const scheduler = createTaskExecution({
      db,
      masterKey: MASTER_KEY,
      outboundAttachmentDirectory: "",
      scheduleSentVerification: () => undefined,
      dueTickMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    scheduler.start(taskId);
    await scheduler.drain();
    await scheduler.stop();

    expect(messageFlagsAdd).toHaveBeenCalled();
    // Every attempt refused, so the ladder ran out: `updated` is 0 because the
    // runner reports only after a push that finished, and the row is closed by
    // the hook's remainder report.
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", total: 2, updated: 0, failed: 2 });
    // The whole point of the composition: without the hooks the target would stay
    // applied and the marker set for ever, and `flags_json` would be read as the
    // server's state from here on.
    expect(flagState(db, "msg-1")).toEqual({ flags_json: "[]", pending_flags_push: 0, pending_flags_base_json: null });
    expect(flagState(db, "msg-2")).toEqual({ flags_json: "[]", pending_flags_push: 0, pending_flags_base_json: null });
    expect(folderUnseen(db)).toBe(2);
  });

  it("announces a settlement on the bus exactly once, with the terminal status", async () => {
    const world = fixture(2);
    db = world.db;
    const taskId = acceptFlags(db, world.ids);
    const bus = new ServerEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const scheduler = createTaskExecution({
      db,
      masterKey: MASTER_KEY,
      outboundAttachmentDirectory: "",
      scheduleSentVerification: () => undefined,
      serverEvents: bus,
      dueTickMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    scheduler.start(taskId);
    await scheduler.drain();
    await scheduler.stop();

    // One settlement, one frame. The status is the row's terminal one, not a
    // claim-time `pending` -- a renderer treats this frame as "go read", so a
    // wrong status is a reconcile it never makes.
    expect(events.filter((event) => event.type === "task-settled")).toEqual([{
      type: "task-settled",
      payload: { accountId: ACCOUNT, taskId, status: "failed" },
    }]);
    // Progress frames are not settlement frames: the refused push reported
    // nothing of its own, and the hook's remainder report is ledger arithmetic,
    // not a runner progress report.
    expect(events.filter((event) => event.type === "task-progress")).toEqual([]);
  });

  it("publishes a progress frame from the stored counters, not the claim-time row", () => {
    const world = fixture(1);
    db = world.db;
    const taskId = acceptFlags(db, world.ids);
    const bus = new ServerEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const hooks = createTaskHooks({ db, serverEvents: bus });

    reportTaskProgress(db, taskId, { updated: 1 }, FIXED_NOW);
    hooks.onTaskProgress!(taskRow(db, taskId) as TaskRow);

    expect(events).toEqual([{
      type: "task-progress",
      payload: { accountId: ACCOUNT, taskId, total: 1, updated: 1, failed: 0 },
    }]);
  });

  it("fires each hook exactly once for one give-up", async () => {
    const world = fixture(2);
    db = world.db;
    const taskId = acceptFlags(db, world.ids);
    const { hooks, counts } = countedHooks(db);
    const scheduler = wired(db, hooks);

    scheduler.start(taskId);
    await scheduler.drain();
    await scheduler.stop();

    // Both fire for one give-up, and each once. The two halves are therefore
    // kind-disjoint rather than guarded against re-entry -- and the row's own
    // arithmetic is the second witness: two remainder reports would read 4.
    expect(counts).toEqual({ settled: 1, permanent: 1 });
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", total: 2, updated: 0, failed: 2 });
    // Asserted because every other expectation here also holds on the
    // `no_runner` path (an unregistered kind is settled `failed` on sight,
    // `scheduler.ts:141-152`), which would make this test green with no runner
    // registered at all. The push reaching the provider is what says an attempt
    // really ran.
    expect(messageFlagsAdd).toHaveBeenCalled();
  });

  it("hands a move task's give-up to the move half", async () => {
    const world = fixture(2);
    db = world.db;
    // No payload: the runner aborts on its first sighting with `no_payload`, so
    // this reaches the give-up without a socket and without a backoff round.
    const taskId = recordMoveTask(db, world.ids, null);
    const { hooks, counts } = countedHooks(db);
    const scheduler = wired(db, hooks);

    scheduler.start(taskId);
    await scheduler.drain();
    await scheduler.stop();

    expect(counts).toEqual({ settled: 1, permanent: 1 });
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "no_payload", failed: 2, total: 2 });
    expect(moveGoalOf(db, "msg-1")).toEqual({ destination: null, state: null });
    expect(moveGoalOf(db, "msg-2")).toEqual({ destination: null, state: null });
    expect(taskItems(db, taskId).map((row) => row.failed)).toEqual([1, 1]);
  });
});
