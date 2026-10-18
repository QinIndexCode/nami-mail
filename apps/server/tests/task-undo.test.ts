import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { acceptFlagsTaskInTransaction, type FlagsTaskDeps } from "../src/tasks/kinds/flags.js";
import { commitUndoTask, failPendingUndoItems } from "../src/tasks/kinds/undo.js";
import { openTaskPayload, recordTask, settleTask, taskRow } from "../src/tasks/store.js";
import { TASK_UNDO_WINDOW_MS, type TaskRow, type TaskSpec } from "../src/tasks/types.js";

/**
 * The undo acceptance: which requests are refused and why, what an accepted one
 * commits, and what it deliberately leaves alone.
 *
 * Every request here goes through the real `commitUndoTask` and the real local
 * writers (`prepareLocalFlags` for the reverse flags write, `recordTask` for the
 * reverse move task). The only stand-in is the starter, because joining a task to
 * its account's chain is not what this file is about -- and the two tests that
 * would care use the real scheduler instead.
 *
 * The seven claims that carry the port, each with a test that fails on its own:
 *
 *   1. the refusal vocabulary is ordered and each word names one condition --
 *      including the two that only differ from each other by *when* the window
 *      was measured (contract §4.7 A (v18)②③);
 *   2. a refused undo commits nothing at all: no task, no selection row, and no
 *      `undone` mark, which is what makes the refusal safe to retry by hand;
 *   3. the `flags` reverse is a *per-entry* inverse, not the negation of the
 *      parent's patch -- the difference is ordinary, and the fixture makes it
 *      visible in both the frozen payload and the committed `flags_json`;
 *   4. the `move` reverse is one `kind='undo'` task whose selection is the parent's
 *      `changed = 1 AND origin_mailbox IS NOT NULL` rows, *including* the ones the
 *      parent latched `failed` (§4.7 A's deliberate deviation from `undoMoveJob`);
 *   5. the `flags` reverse groups by the inverse each entry needs: two deltas make two
 *      writes, one delta makes one write over two ids;
 *   6. the one-undo claim and the reverse write are one commit, on both branches --
 *      proved from the outside by making the reverse *unwritable* and asserting the
 *      parent is still claimable;
 *   7. a reverse with no work left to do spends the one undo and commits no task, on
 *      both branches -- the flags half because its delta recomputes to nothing, the
 *      move half because the parent's selection was empty to begin with.
 */

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const INBOX = "INBOX";
const ARCHIVE = "Archive";
const TRASH = "Trash";
const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";

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

function insertMessage(db: DatabaseHandle, id: string, uid: number, mailbox: string, flags: string[]): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ACCOUNT, mailbox, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify(flags), 0, 0, new Date().toISOString());
}

let db: DatabaseHandle;

beforeEach(() => {
  db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db, INBOX, "Inbox", "\\Inbox");
  insertFolder(db, ARCHIVE, "Archive", "\\Archive");
  insertFolder(db, TRASH, "Trash", "\\Trash");
});

afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
});

/** The acceptance's deps with a recording starter instead of a real scheduler. */
function undoDeps(): { deps: FlagsTaskDeps; started: string[] } {
  const started: string[] = [];
  return { deps: { db, masterKey: MASTER_KEY, scheduler: { start: (id: string) => started.push(id) } }, started };
}

const taskIds = (): string[] => db.prepare("SELECT id FROM tasks ORDER BY rowid").pluck().all() as string[];

const itemRows = (taskId: string): Array<Record<string, unknown>> =>
  db.prepare("SELECT message_id, changed, origin_mailbox, destination_mailbox, failed FROM task_items WHERE task_id = ? ORDER BY rowid")
    .all(taskId) as Array<Record<string, unknown>>;

const flagsOf = (id: string): string[] =>
  JSON.parse((db.prepare("SELECT flags_json FROM messages WHERE id = ?").pluck().get(id) as string)) as string[];

const undoneOf = (id: string): number => db.prepare("SELECT undone FROM tasks WHERE id = ?").pluck().get(id) as number;

/**
 * A completed parent, the way one becomes completed: `recordTask` writes the row
 * `pending` (and, for a batch, its selection), and `settleTask` ends it -- which is
 * also what writes the `completed_at` the undo window is measured from.
 */
function completedParent(spec: TaskSpec, completedAt: number): string {
  const id = recordTask(db, MASTER_KEY, spec);
  settleTask(db, id, "completed", null, completedAt);
  return id;
}

/** A parent move task: ids in `Archive`, each with its own origin, no failures. */
function moveParent(ids: readonly string[], completedAt: number): string {
  return completedParent(
    {
      accountId: ACCOUNT,
      kind: "move",
      scope: "batch",
      undoWindowMs: TASK_UNDO_WINDOW_MS,
      payload: { target: "archive" },
      items: ids.map((messageId) => ({ messageId, changed: true, originMailbox: INBOX, destinationMailbox: ARCHIVE })),
    },
    completedAt,
  );
}

/**
 * A parent flags task built by the real forward acceptance, so its payload is a
 * real frozen-entries payload rather than a test's idea of one.
 */
function flagsParent(ids: readonly string[], patch: { seen?: boolean; flagged?: boolean }, completedAt: number): string {
  const { deps } = undoDeps();
  const accepted = db.transaction(() => acceptFlagsTaskInTransaction(deps, { messageIds: ids, patch, undoWindowMs: TASK_UNDO_WINDOW_MS }))();
  for (const handle of accepted.handles) handle.start();
  expect(accepted.handles, "the fixture wants exactly one task for its patch").toHaveLength(1);
  const taskId = accepted.handles[0]!.id;
  settleTask(db, taskId, "completed", null, completedAt);
  return taskId;
}

describe("task undo acceptance: the refusal vocabulary", () => {
  it("names one condition per word, refuses in a fixed order, and commits nothing", () => {
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, ARCHIVE, []);
    const { deps, started } = undoDeps();
    // Every row this test's fixture creates, so a refusal can be asserted against
    // "the database is exactly what the fixture made": a refusal that quietly wrote a
    // task row, a selection row or an `undone` mark would show up here.
    const fixture: string[] = [];
    const track = (id: string): string => {
      fixture.push(id);
      return id;
    };
    const committedNothing = (): void => {
      expect(taskIds()).toEqual(fixture);
      expect(started).toEqual([]);
    };

    // `not_found` is answered without reading anything else -- there is no row to
    // ask about a kind or a window.
    expect(commitUndoTask(deps, "nope", now)).toEqual({ ok: false, reason: "not_found" });

    // A kind whose action never offers an undo. `send` is the clearest: it has a real
    // payload and a real completion, and still has nothing to reverse.
    const sent = track(completedParent({ accountId: ACCOUNT, kind: "send", scope: "single" }, now - 1_000));
    expect(commitUndoTask(deps, sent, now)).toEqual({ ok: false, reason: "unsupported_parent" });

    // The migrated `kind='undo'` record lands on the same word, and the assertion is
    // here to keep it from drifting to `expired`: the kind clause is first, so an
    // `undo` row is refused as unsupported no matter how its window or completion
    // timestamp reads. (`expired` is the migrated *flags* record's outcome -- the next
    // describe has that shape, and the code comment on `undoRefusal` says why.)
    const migratedUndo = track(completedParent(
      { accountId: ACCOUNT, kind: "undo", scope: "single", undoWindowMs: TASK_UNDO_WINDOW_MS, payload: { ids: ["msg-1"], patch: {} } },
      now - 1_000,
    ));
    expect(commitUndoTask(deps, migratedUndo, now)).toEqual({ ok: false, reason: "unsupported_parent" });

    // `not_completed` covers all four non-`completed` statuses, and it is checked
    // before the window: a pending parent with no window reports the status, not
    // `no_window` (§4.7 A (v18)②). The other order would send a user looking for a
    // missing window on a task that has not finished yet.
    const pending = track(recordTask(db, MASTER_KEY, { accountId: ACCOUNT, kind: "move", items: [{ messageId: "msg-1", changed: true, originMailbox: INBOX }] }));
    expect(commitUndoTask(deps, pending, now)).toEqual({ ok: false, reason: "not_completed" });
    // A `failed` parent is the case that made the word "terminal" wrong: it is
    // terminal, and it still has nothing to undo.
    const failed = track(recordTask(db, MASTER_KEY, { accountId: ACCOUNT, kind: "move", undoWindowMs: TASK_UNDO_WINDOW_MS, items: [{ messageId: "msg-1", changed: true, originMailbox: INBOX }] }));
    settleTask(db, failed, "failed", { code: "boom", message: "boom" }, now - 1_000);
    expect(commitUndoTask(deps, failed, now)).toEqual({ ok: false, reason: "not_completed" });

    // `already_undone` beats the window: the mark is the one-undo guarantee, and a
    // second undo of a task that was already undone is not "expired". The parent's
    // completion is deliberately *outside* the window, so the two readings disagree
    // and only the order explains the answer -- with a fresh parent both orders would
    // return `already_undone` and the assertion would pass either way.
    const taken = track(moveParent(["msg-1"], now - TASK_UNDO_WINDOW_MS - 1));
    db.prepare("UPDATE tasks SET undone = 1 WHERE id = ?").run(taken);
    expect(commitUndoTask(deps, taken, now)).toEqual({ ok: false, reason: "already_undone" });

    // `no_window` is a separate word from `unsupported_parent` on purpose: this is a
    // kind that *can* be undone, by an action that did not offer it (a single move).
    // Collapsing the two would hide the wiring mistake §4.3b 第 3 条第 9 项 ② describes.
    const single = track(completedParent({ accountId: ACCOUNT, kind: "move", items: [{ messageId: "msg-1", changed: true, originMailbox: INBOX }] }, now - 1_000));
    expect(commitUndoTask(deps, single, now)).toEqual({ ok: false, reason: "no_window" });

    // `expired` has two shapes and both are real: a completion timestamp that was
    // never written (which is how `jobTaskCompletedAt` makes a migrated *flags* record
    // read -- `migrate.ts:462-465`, and the kind set is what keeps the `undo`-kinded
    // ones off this branch), and one that is simply old.
    const timeless = track(moveParent(["msg-1"], now - 1_000));
    db.prepare("UPDATE tasks SET completed_at = NULL WHERE id = ?").run(timeless);
    expect(commitUndoTask(deps, timeless, now)).toEqual({ ok: false, reason: "expired" });
    const stale = track(moveParent(["msg-1"], now - TASK_UNDO_WINDOW_MS - 1));
    expect(commitUndoTask(deps, stale, now)).toEqual({ ok: false, reason: "expired" });

    committedNothing();
    // The mark is asserted for the two rows that carry one, so `committedNothing`
    // cannot pass by comparing rows nobody claimed.
    expect(undoneOf(taken)).toBe(1);
    for (const id of [sent, pending, failed, single, timeless, stale]) expect(undoneOf(id)).toBe(0);
  });

  it("accepts a request landing exactly on the deadline", () => {
    // The guard is `now - completed_at > undo_window_ms`, so the boundary belongs to
    // the user: an undo offered at this instant must still work. The other reading
    // refuses a request the UI is still showing a button for.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, ARCHIVE, []);
    const parent = moveParent(["msg-1"], now - TASK_UNDO_WINDOW_MS);
    const { deps, started } = undoDeps();

    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok && outcome.taskIds).toHaveLength(1);
    expect(started).toEqual(outcome.ok ? outcome.taskIds : []);
    expect(undoneOf(parent)).toBe(1);
    // One second later the same request is refused, which is what makes the boundary
    // a boundary rather than a coincidence of the fixture.
    const second = moveParent(["msg-1"], now - TASK_UNDO_WINDOW_MS - 1);
    expect(commitUndoTask(deps, second, now)).toEqual({ ok: false, reason: "expired" });
    expect(undoneOf(second)).toBe(0);
  });
});

describe("task undo acceptance: a flags parent reverses as the flags write it was", () => {
  it("commits one flags task per distinct inverse delta, and never a second executor", () => {
    const now = 1_000_000;
    // msg-1 is already seen; msg-2 is not. The forward patch sets both flags on
    // both messages, so the two entries carry *different* deltas -- which is the
    // whole reason the reverse is grouped per entry instead of per patch.
    insertMessage(db, "msg-1", 1, INBOX, [SEEN]);
    insertMessage(db, "msg-2", 2, INBOX, []);
    const parent = flagsParent(["msg-1", "msg-2"], { seen: true, flagged: true }, now - 1_000);
    expect(flagsOf("msg-1")).toEqual([SEEN, FLAGGED]);
    expect(flagsOf("msg-2")).toEqual([SEEN, FLAGGED]);

    const { deps, started } = undoDeps();
    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome.ok).toBe(true);
    const created = outcome.ok ? outcome.taskIds : [];
    expect(started).toEqual(created);

    // What the user ends up with, asserted before the shape of the work that produced
    // it. The inverse is per entry: msg-1 loses only `\Flagged` (it was already seen,
    // and the forward write never touched `\Seen`), msg-2 loses both. The uniform
    // negation of the parent's `{seen: true, flagged: true}` would have marked msg-1
    // unread -- so this pair is what a uniform negation must fail first, before the
    // grouping it also gets wrong is even looked at.
    expect(flagsOf("msg-1")).toEqual([SEEN]);
    expect(flagsOf("msg-2")).toEqual([]);

    // Which takes one task per distinct inverse delta: two entries, two deltas.
    expect(created).toHaveLength(2);
    // The parent's one undo is consumed, and it was consumed in the same commit as
    // the reverse writes -- a crash between them would leave the reverse behind and
    // the mark unset, which is the one state `acceptFlagsJob`'s comment rules out.
    expect(undoneOf(parent)).toBe(1);

    // No intermediate `undo` task: the reverse of a flags write is a flags write, so
    // it drains on the one pipeline.
    expect(db.prepare("SELECT COUNT(*) FROM tasks WHERE kind = 'undo'").pluck().get()).toBe(0);

    // The frozen payload is the same fact one layer down, and it is what the runner
    // will push: add/remove swapped per entry.
    const frozen = created.map((id) => openTaskPayload<{ entries: Array<{ id: string; add: string[]; remove: string[] }> }>(MASTER_KEY, taskRow(db, id) as TaskRow)!);
    expect(frozen).toEqual([
      { accountId: ACCOUNT, entries: [expect.objectContaining({ id: "msg-1", add: [], remove: [FLAGGED] })] },
      { accountId: ACCOUNT, entries: [expect.objectContaining({ id: "msg-2", add: [], remove: [SEEN, FLAGGED] })] },
    ]);
    for (const id of created) {
      expect(taskRow(db, id)).toMatchObject({ kind: "flags", account_id: ACCOUNT, status: "pending", parent_id: null, total: 1, undone: 0 });
    }

    // A second undo of the same parent finds the mark taken and adds nothing.
    const before = taskIds();
    expect(commitUndoTask(deps, parent, now)).toEqual({ ok: false, reason: "already_undone" });
    expect(taskIds()).toEqual(before);
  });

  it("merges the entries that need the same inverse into one write", () => {
    // The other half of "one task per distinct inverse delta", and the half the test
    // above cannot see: there, the two entries' inverses *differ*, so an
    // implementation that never grouped anything -- one task per entry -- produces the
    // same shape. Here both messages start in the same state and get the same patch,
    // so both entries carry the same inverse and the reverse is one flags write over
    // two ids. Without the assertion this file would document a grouping it never
    // exercises.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    insertMessage(db, "msg-2", 2, INBOX, []);
    const parent = flagsParent(["msg-1", "msg-2"], { seen: true }, now - 1_000);
    expect(flagsOf("msg-1")).toEqual([SEEN]);
    expect(flagsOf("msg-2")).toEqual([SEEN]);

    const { deps, started } = undoDeps();
    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome.ok).toBe(true);
    const created = outcome.ok ? outcome.taskIds : [];
    expect(started).toEqual(created);
    expect(flagsOf("msg-1")).toEqual([]);
    expect(flagsOf("msg-2")).toEqual([]);

    // One task, two entries, and the payload says so: the group is a *messageIds*
    // list, so the merge survives into what the runner pushes (one IMAP command over
    // both uids rather than two commands).
    expect(created).toHaveLength(1);
    expect(taskRow(db, created[0]!)).toMatchObject({ kind: "flags", scope: "batch", total: 2 });
    const frozen = openTaskPayload<{ entries: Array<{ id: string; add: string[]; remove: string[] }> }>(MASTER_KEY, taskRow(db, created[0]!) as TaskRow)!;
    expect(frozen.entries.map((entry) => entry.id)).toEqual(["msg-1", "msg-2"]);
    expect(frozen.entries.map((entry) => ({ add: entry.add, remove: entry.remove })))
      .toEqual([{ add: [], remove: [SEEN] }, { add: [], remove: [SEEN] }]);
    expect(itemRows(created[0]!).map((row) => row.message_id)).toEqual(["msg-1", "msg-2"]);
    expect(undoneOf(parent)).toBe(1);
  });

  it("spends the one undo and commits nothing when the reverse is already in force", () => {
    // A flags inverse can be a no-op, and the ordinary way there is the user's own
    // later write: msg-1 is marked read, then marked unread again by hand before the
    // undo is pressed. `prepareLocalFlags` recomputes each delta against the state it
    // finds (`kinds/flags.ts:186`), so the reverse group materializes no entry and
    // there is nothing to carry into a task.
    //
    // The legacy shape here was a 0-work job rather than nothing: `acceptFlagsJob` had
    // no empty-delta early return and INSERTed unconditionally
    // (deleted `batch-jobs.ts:382-385`), so `undoFlagsJob` always produced a job id
    // to hand back. `taskIds: []` is therefore a visible difference on the
    // acceptance's return value, and the reason the route has to read that value
    // rather than assume one id.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    const parent = flagsParent(["msg-1"], { seen: true }, now - 1_000);
    expect(flagsOf("msg-1")).toEqual([SEEN]);
    // Whoever put the message back -- the user, another client -- this is the state
    // the parent's inverse (`remove: [\Seen]`) would ask for, so it has nothing left
    // to ask for.
    db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify([]), "msg-1");

    const { deps, started } = undoDeps();
    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome).toEqual({ ok: true, taskIds: [] });
    expect(started).toEqual([]);
    // The claim is the whole of what this undo left behind, and it did happen: the one
    // undo is spent, so a second press cannot re-run a reverse nobody needs, and no
    // task row exists to settle `0/0` later.
    expect(undoneOf(parent)).toBe(1);
    expect(taskIds()).toEqual([parent]);
    expect(flagsOf("msg-1")).toEqual([]);
    expect(commitUndoTask(deps, parent, now)).toEqual({ ok: false, reason: "already_undone" });
    expect(taskIds()).toEqual([parent]);
  });

  it("keeps the undo itself undoable, the way the legacy's rows did", () => {
    // `undoFlagsJob` accepted its reverse through the same `acceptFlagsJob`, which
    // wrote `BATCH_JOB_UNDO_WINDOW_MS` on every row it inserted (deleted
    // `batch-jobs.ts:383-385`) -- including the `undo`-kinded one. So "undo the
    // undo" was possible for flags and still is; the reverse tasks carry the window.
    // The move half cannot follow (see the next describe): a restore's own reverse
    // would have to name each message's destination, which a symbolic `move` target
    // cannot express, and the legacy agreed -- `undoMoveJob` returned no new job.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    const parent = flagsParent(["msg-1"], { seen: true }, now - 1_000);

    const { deps } = undoDeps();
    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome).toMatchObject({ ok: true });
    const undoTask = outcome.ok ? outcome.taskIds[0]! : "";
    expect(taskRow(db, undoTask)).toMatchObject({ kind: "flags", undo_window_ms: TASK_UNDO_WINDOW_MS, undone: 0 });
    // And the window it carries is the one the guard reads: once the reverse has
    // finished, a second undo aimed at it is accepted rather than refused as
    // `no_window`, and it puts the flag back on.
    settleTask(db, undoTask, "completed", null, now);
    expect(commitUndoTask(deps, undoTask, now)).toMatchObject({ ok: true });
    expect(undoneOf(undoTask)).toBe(1);
    expect(flagsOf("msg-1")).toEqual([SEEN]);
  });

  it("refuses a parent whose payload records no per-entry delta", () => {
    // The historical spelling: ids plus a patch, written by `planJob` for migrated
    // flags/undo records (`migrate.ts:413-426`). The inverse cannot be reconstructed
    // from it -- the patch is what was *asked for*, not what each message got -- and
    // guessing here would reverse flags the forward write never touched.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, [SEEN]);
    const parent = completedParent(
      { accountId: ACCOUNT, kind: "flags", undoWindowMs: TASK_UNDO_WINDOW_MS, payload: { ids: ["msg-1"], patch: { flagged: true } } },
      now - 1_000,
    );
    const { deps, started } = undoDeps();

    expect(commitUndoTask(deps, parent, now)).toEqual({ ok: false, reason: "inverse_unavailable" });
    expect(started).toEqual([]);
    expect(undoneOf(parent)).toBe(0);
    expect(taskIds()).toEqual([parent]);
    expect(flagsOf("msg-1")).toEqual([SEEN]);
  });

  it("refuses to reverse a flag this vocabulary cannot express", () => {
    // Unreachable from any writer -- `commitLocalFlags` only ever emits the two
    // names in `messageFlagNames` -- but a reverse that guessed at `\Answered` would
    // be worse than a refusal, so the guard is stated rather than assumed. The
    // payload is written by hand precisely because no code path produces one.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    const parent = completedParent(
      {
        accountId: ACCOUNT,
        kind: "flags",
        undoWindowMs: TASK_UNDO_WINDOW_MS,
        payload: { accountId: ACCOUNT, entries: [{ id: "msg-1", mailbox: INBOX, uid: 1, add: ["\\Answered"], remove: [] }] },
      },
      now - 1_000,
    );
    const { deps, started } = undoDeps();

    expect(commitUndoTask(deps, parent, now)).toEqual({ ok: false, reason: "inverse_unavailable" });
    expect(started).toEqual([]);
    expect(undoneOf(parent)).toBe(0);
  });
});

describe("task undo acceptance: a move parent reverses as one undo task", () => {
  it("materializes the parent's selection, including the rows the parent latched failed", () => {
    const now = 1_000_000;
    for (const [index, id] of ["msg-1", "msg-2", "msg-3", "msg-4"].entries()) {
      insertMessage(db, id, index + 1, ARCHIVE, []);
    }
    // Four shapes of selection row, three of which the scope has an opinion about.
    const parent = completedParent(
      {
        accountId: ACCOUNT,
        kind: "move",
        scope: "batch",
        undoWindowMs: TASK_UNDO_WINDOW_MS,
        payload: { target: "archive" },
        items: [
          { messageId: "msg-1", changed: true, originMailbox: INBOX, destinationMailbox: ARCHIVE },
          // Latched `failed` by the parent's own give-back, yet it may well have
          // arrived (§4.7 (v14)'s interleaving). `undoMoveJob:1027` excluded it; this
          // one does not, and the runner's first guard makes an untouched message
          // cost one comparison.
          { messageId: "msg-2", changed: true, originMailbox: INBOX, destinationMailbox: ARCHIVE, failed: true },
          // The parent's no-op share: nothing was asked of it, so there is nothing to
          // restore.
          { messageId: "msg-3", changed: false, originMailbox: INBOX, destinationMailbox: ARCHIVE },
          // No origin recorded: there is no folder to restore it to.
          { messageId: "msg-4", changed: true, originMailbox: null, destinationMailbox: ARCHIVE },
        ],
      },
      now - 1_000,
    );
    const { deps, started } = undoDeps();

    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome).toMatchObject({ ok: true });
    const undoTask = outcome.ok ? outcome.taskIds[0]! : "";
    // One task, because a move's reverse is one *symbolic* job: the destinations
    // differ per message, and that is data on the selection rows rather than a
    // reason for two tasks.
    expect(outcome.ok && outcome.taskIds).toHaveLength(1);
    expect(started).toEqual([undoTask]);
    expect(taskRow(db, undoTask)).toMatchObject({
      kind: "undo",
      account_id: ACCOUNT,
      parent_id: parent,
      // More than one entry, so the scope the acceptance derives from the selection
      // is the batch one.
      scope: "batch",
      status: "pending",
      total: 2,
      updated: 0,
      failed: 0,
      // An undo is not undoable: its own inverse is not expressible, and `undone`
      // stays 0 because nothing consumed it.
      undo_window_ms: null,
      undone: 0,
    });
    expect(openTaskPayload(MASTER_KEY, taskRow(db, undoTask) as TaskRow)).toEqual({ target: "archive" });
    expect(itemRows(undoTask)).toEqual([
      { message_id: "msg-1", changed: 1, origin_mailbox: INBOX, destination_mailbox: null, failed: 0 },
      { message_id: "msg-2", changed: 1, origin_mailbox: INBOX, destination_mailbox: null, failed: 0 },
    ]);
    // The parent is claimed, and only that column moved.
    expect(taskRow(db, parent)).toMatchObject({ status: "completed", undone: 1, total: 4, updated: 0, failed: 0 });
    // The claimed `failed` row is not carried over as failed: this task owes it, and
    // owes it as work to do.
    expect(db.prepare("SELECT COUNT(*) FROM tasks WHERE kind = 'undo'").pluck().get()).toBe(1);
  });

  it("derives a single-entry scope, and records no payload when the parent had none", () => {
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, ARCHIVE, []);
    // A parent with no target: the legacy read it as `parent.target ?? undefined`
    // (`:1072`), so a target-less parent is a shape rather than an error and the
    // runner skips its destination guard for it. The historical spelling that lands
    // there is a migrated record's `{patch}` payload -- no `move` acceptance writes
    // one -- which is why the guard is stated rather than assumed.
    const parent = completedParent(
      {
        accountId: ACCOUNT,
        kind: "move",
        undoWindowMs: TASK_UNDO_WINDOW_MS,
        items: [{ messageId: "msg-1", changed: true, originMailbox: INBOX, destinationMailbox: ARCHIVE }],
      },
      now - 1_000,
    );
    const { deps } = undoDeps();

    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome).toMatchObject({ ok: true });
    const undoTask = outcome.ok ? outcome.taskIds[0]! : "";
    expect(taskRow(db, undoTask)).toMatchObject({ scope: "single", total: 1 });
    const row = taskRow(db, undoTask) as TaskRow;
    // Absent rather than sealed-as-empty: "no payload" and "empty payload" stay
    // distinguishable (`store.ts:223`), and the send kind depends on the difference.
    expect(row.payload_ciphertext).toBeNull();
    expect(row.payload_version).toBe(1);
    expect(openTaskPayload(MASTER_KEY, row)).toBeUndefined();
  });

  it("commits no task for a parent whose selection moved nothing", () => {
    // `changed = 0` is the legacy's own way of recording "this message needed no work"
    // (it was already at the destination at acceptance), which is why it stays in the
    // scope predicate -- the one clause this port removes is `failed = 0`. So a parent
    // whose every row is like this has an empty selection, and an empty selection owes
    // no task: the row would only ever settle `0/0`, and the legacy wrote no row for
    // the move half at all (`undoMoveJob`).
    //
    // This is the case that has to agree with the flags half above, and it agrees by
    // construction: both branches return `[]` rather than a phantom handle.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, ARCHIVE, []);
    const parent = completedParent(
      {
        accountId: ACCOUNT,
        kind: "move",
        undoWindowMs: TASK_UNDO_WINDOW_MS,
        payload: { target: "archive" },
        // Origin and destination are filled in on purpose: the row is out of scope
        // because `changed = 0`, not because it lacks somewhere to return to.
        items: [{ messageId: "msg-1", changed: false, originMailbox: INBOX, destinationMailbox: ARCHIVE }],
      },
      now - 1_000,
    );

    const { deps, started } = undoDeps();
    const outcome = commitUndoTask(deps, parent, now);

    expect(outcome).toEqual({ ok: true, taskIds: [] });
    expect(started).toEqual([]);
    expect(undoneOf(parent)).toBe(1);
    expect(taskIds()).toEqual([parent]);
    // Nothing claimed a goal and nothing restored: the message is where it was.
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").pluck().get("msg-1")).toBe(ARCHIVE);
  });
});

describe("task undo acceptance: the permanent-failure latch stays inside its own kind", () => {
  it("cannot latch a selection a flags task owns", () => {
    // The settlement hook dispatches by kind, so this call is a wiring mistake rather
    // than a path. A wiring mistake must not corrupt a live push's selection, and the
    // undo's blanket latch is the one statement on this surface that could: a `flags`
    // task's rows are `changed = 1` with no origin (`kinds/flags.ts:223`), so a latch
    // scoped only by `changed`/`failed` matches every one of them and marks them
    // failed restores -- while the counts stay consistent (`updated + failed == total`
    // holds either way), which is why nothing downstream would notice.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    insertMessage(db, "msg-2", 2, INBOX, []);
    const flagsTask = flagsParent(["msg-1", "msg-2"], { seen: true }, now - 1_000);
    expect(itemRows(flagsTask).map((row) => row.changed)).toEqual([1, 1]);

    expect(failPendingUndoItems(db, { id: flagsTask })).toBe(0);
    expect(itemRows(flagsTask).map((row) => row.failed)).toEqual([0, 0]);
  });
});

describe("task undo acceptance: the claim and the reverse are one commit", () => {
  it("leaves the parent unclaimed when the move reverse cannot be committed", () => {
    // A trigger is the only way to make the second half of the acceptance fail on
    // demand, and what the failure proves is the *absence* of the first half. The
    // `undone` mark rides in the same transaction as the task row, so a reverse that
    // cannot be written takes the claim with it -- an implementation that committed
    // the mark first (the shape `acceptFlagsJob`'s comment rules out) leaves
    // `undone = 1` here, i.e. the user's one undo consumed by a task that does not
    // exist and a restore that will never be retried.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, ARCHIVE, []);
    const parent = moveParent(["msg-1"], now - 1_000);
    const before = taskIds();
    db.prepare("CREATE TRIGGER refuse_reverse BEFORE INSERT ON tasks WHEN NEW.kind = 'undo' BEGIN SELECT RAISE(ABORT, 'reverse refused'); END").run();

    const { deps, started } = undoDeps();
    expect(() => commitUndoTask(deps, parent, now)).toThrow(/reverse refused/);

    expect(undoneOf(parent)).toBe(0);
    expect(taskIds()).toEqual(before);
    expect(started).toEqual([]);
    // And nothing local moved: the message is still in Archive, which is the state a
    // retried undo has to find.
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").pluck().get("msg-1")).toBe(ARCHIVE);
  });

  it("leaves the parent unclaimed when the flags reverse cannot be committed", () => {
    // The other branch, and the same obligation. The flags reverse writes the target
    // state *and* the reverse task in the caller's transaction, so the parent's mark
    // cannot outlive a reverse that never landed -- which for flags is the difference
    // between "the flag is still on and the undo is repeatable" and "the flag is still
    // on and the undo is gone".
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    const parent = flagsParent(["msg-1"], { seen: true }, now - 1_000);
    expect(flagsOf("msg-1")).toEqual([SEEN]);
    const before = taskIds();
    db.prepare("CREATE TRIGGER refuse_reverse BEFORE INSERT ON tasks WHEN NEW.kind = 'flags' BEGIN SELECT RAISE(ABORT, 'reverse refused'); END").run();

    const { deps, started } = undoDeps();
    expect(() => commitUndoTask(deps, parent, now)).toThrow(/reverse refused/);

    expect(undoneOf(parent)).toBe(0);
    expect(flagsOf("msg-1")).toEqual([SEEN]);
    expect(taskIds()).toEqual(before);
    expect(started).toEqual([]);
  });
});
