import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { commitJobUndo, jobSnapshot } from "../src/tasks/jobs.js";
import { acceptFlagsTaskInTransaction, type FlagsTaskDeps } from "../src/tasks/kinds/flags.js";
import { recordTask, reportTaskProgress, settleTask, taskRow } from "../src/tasks/store.js";
import { TASK_UNDO_WINDOW_MS, type TaskSpec, type TaskStatus } from "../src/tasks/types.js";

/**
 * The batch-job compatibility alias: how one job id resolves to the tasks behind
 * it, what the progress numbers mean when those tasks do not agree about what
 * they are counting, and what undoing a job does to every account of it.
 *
 * Nothing here goes through a route: `GET /api/batch-jobs/:id` is the caller
 * (`routes/batch-jobs.ts:117`), and reading this module directly is what lets the
 * tests below pin one shape at a time. What the tests pin, each assertion failing
 * on its own:
 *
 *   1. a job the task layer accepted has one member per account, each counting
 *      **its own slice**, and the job's numbers are their sum;
 *   2. a job the migration carried over has each member holding a **copy** of the
 *      job's numbers (`migrate.ts:542-547`), so those are read **once** -- and the
 *      reading is a lower bound on `updated`/`failed` rather than an over-report,
 *      because the baseline every copy repeats is stored nowhere;
 *   3. `done` is the legacy's two branches (`row.total - syncing` while running,
 *      `row.total` once settled) recomputed from the aggregate, on top of the
 *      ceiling the store itself keeps (`updated`/`failed` stop at `total`);
 *   4. the status mapping is exhaustive; a settled job reads `failed` only when
 *      *nothing* of it got through, because the renderer's `failed` branch drops
 *      both counts and the one-shot undo (contract §8 G11);
 *   5. the id resolution is a colon-anchored prefix, so it reads no wildcard and
 *      lets no job id reach another job's members -- and a migrated `undo` job, which
 *      is a job in its own right, resolves by its own root like any other;
 *   6. a lone task is a job of one -- the shape the renderer follows after an undo;
 *   7. undoing a job fans out over every member, and refuses **without claiming
 *      anything** when one of them cannot be undone -- including the refusals and the
 *      throws that are only knowable from a member's payload.
 */

const ACCOUNT = "acc-1";
const ACCOUNT_2 = "acc-2";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const INBOX = "INBOX";
const ARCHIVE = "Archive";
const SEEN = "\\Seen";
const DESTINATION = "archive";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function insertAccount(db: DatabaseHandle, id: string, email: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

function insertFolder(db: DatabaseHandle, accountId: string, path: string, name: string, specialUse: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(accountId, path, name, specialUse);
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
  insertAccount(db, ACCOUNT, "one@example.com");
  insertAccount(db, ACCOUNT_2, "two@example.com");
  insertFolder(db, ACCOUNT, INBOX, "Inbox", "\\Inbox");
  insertFolder(db, ACCOUNT, ARCHIVE, "Archive", "\\Archive");
  insertFolder(db, ACCOUNT_2, INBOX, "Inbox", "\\Inbox");
  insertFolder(db, ACCOUNT_2, ARCHIVE, "Archive", "\\Archive");
});

afterEach(() => {
  db?.close();
});

/** The alias's own deps, with the recording starter the undo tests use. */
function undoDeps(): { deps: FlagsTaskDeps; started: string[] } {
  const started: string[] = [];
  return { deps: { db, masterKey: MASTER_KEY, scheduler: { start: (id: string) => started.push(id) } }, started };
}

/** A selection of `count` ids, spelled out so each member's own slice is visible. */
function selection(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

const moveItems = (messageIds: readonly string[]) =>
  messageIds.map((messageId) => ({ messageId, changed: true, originMailbox: INBOX, destinationMailbox: ARCHIVE }));

/**
 * One member of a job, written the way an acceptance writes it: `total` is the
 * size of the slice it carries, and its runner counts that slice.
 */
function member(id: string, accountId: string, messageIds: readonly string[], extra: Partial<TaskSpec> = {}): string {
  return recordTask(db, MASTER_KEY, {
    id,
    accountId,
    kind: "move",
    scope: "batch",
    total: messageIds.length,
    items: moveItems(messageIds),
    payload: { target: DESTINATION },
    undoWindowMs: TASK_UNDO_WINDOW_MS,
    ...extra,
  });
}

/**
 * One member of a job as the migration writes it: the job's own numbers copied
 * column for column into every account's row (`migrate.ts:542-547`).
 */
function copiedMember(id: string, accountId: string, messageIds: readonly string[], jobTotal: number): string {
  return recordTask(db, MASTER_KEY, {
    id,
    accountId,
    kind: "move",
    scope: "batch",
    total: jobTotal,
    items: moveItems(messageIds),
    payload: { target: DESTINATION },
    undoWindowMs: TASK_UNDO_WINDOW_MS,
    now: 1_000,
  });
}

/**
 * One member of a migrated **undo** job: the same copy shape, and the kind the
 * migration keeps from the legacy row (`migrate.ts:413-426`'s `planJob` returns
 * `kind: job.kind`, and a flags undo was a `batch_jobs` row of its own,
 * `batch-jobs.ts:1031`, deleted).
 */
function undoMember(id: string, accountId: string, messageIds: readonly string[], jobTotal: number): string {
  return recordTask(db, MASTER_KEY, {
    id,
    accountId,
    kind: "undo",
    scope: "batch",
    total: jobTotal,
    items: messageIds.map((messageId) => ({ messageId, changed: true, originMailbox: ARCHIVE })),
    payload: { patch: { seen: true } },
    undoWindowMs: TASK_UNDO_WINDOW_MS,
    now: 1_000,
  });
}

const advance = (id: string, delta: { updated?: number; failed?: number }, now = 2_000): void => {
  reportTaskProgress(db, id, delta, now);
};
const taskIds = (): string[] => db.prepare("SELECT id FROM tasks ORDER BY rowid").pluck().all() as string[];
const undoneOf = (id: string): number => db.prepare("SELECT undone FROM tasks WHERE id = ?").pluck().get(id) as number;
const itemIds = (id: string): string[] =>
  db.prepare("SELECT message_id FROM task_items WHERE task_id = ? ORDER BY rowid").pluck().all(id) as string[];
const flagsOf = (id: string): string[] =>
  JSON.parse(db.prepare("SELECT flags_json FROM messages WHERE id = ?").pluck().get(id) as string) as string[];

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

describe("the batch-job alias: one job id, the tasks behind it", () => {
  it("sums a per-account job, because every member counts its own slice", () => {
    const first = member("job-1", ACCOUNT, selection("a", 3), { now: 5_000 });
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 4));
    advance(first, { updated: 1 });
    advance(second, { updated: 2, failed: 1 });

    // Seven ids accepted across two accounts; four of them are no longer owed --
    // three succeeded, one was given up. `done` is the legacy's running branch
    // (`row.total - syncing`), so it counts the given-up id as no longer pending
    // rather than as a success; `updated` and `failed` stay separate.
    expect(jobSnapshot(db, "job-1")).toEqual({
      id: "job-1",
      kind: "move",
      status: "running",
      total: 7,
      done: 4,
      updated: 3,
      failed: 1,
      createdAt: 5_000,
      undoWindowMs: TASK_UNDO_WINDOW_MS,
    });
  });

  it("resolves the whole job from any of its member ids", () => {
    member("job-1", ACCOUNT, selection("a", 3));
    member("job-1:acc-2", ACCOUNT_2, selection("b", 4));

    // A member's id is the one a caller is most likely to be holding (an
    // acceptance returns one per account), so it has to resolve the job rather
    // than answer with that account's slice.
    const job = jobSnapshot(db, "job-1")!;
    expect(job.total).toBe(7);
    expect(jobSnapshot(db, "job-1:acc-2")).toEqual({ ...job, id: "job-1:acc-2" });
  });

  it("reads a migrated job's copied numbers once, not once per account", () => {
    // What the migration writes: two accounts, each row holding the job's own
    // total (10, though it carries 5) and its own updated. Summing is the one
    // reading that is certainly wrong -- it would report a 20-message job.
    const first = copiedMember("legacy-1", ACCOUNT, selection("a", 5), 10);
    const second = copiedMember("legacy-1:acc-2", ACCOUNT_2, selection("b", 5), 10);
    advance(first, { updated: 4 });
    advance(second, { updated: 4 });

    expect(jobSnapshot(db, "legacy-1")).toEqual({
      id: "legacy-1",
      kind: "move",
      status: "running",
      total: 10,
      done: 4,
      updated: 4,
      failed: 0,
      createdAt: 1_000,
      undoWindowMs: TASK_UNDO_WINDOW_MS,
    });
  });

  it("keeps a migrated job's numbers below the truth when its accounts advanced unevenly", () => {
    // Each member's column is the shared baseline (4) plus that account's own
    // arrivals, so the true settled count here is 4 + 3 + 0 = 7 -- and 7 is what
    // `updated` reports, because the account that has not moved still holds the
    // baseline. `done` follows the three columns, and no arrangement of these
    // copies can drive it above the truth.
    const first = copiedMember("legacy-1", ACCOUNT, selection("a", 5), 10);
    const second = copiedMember("legacy-1:acc-2", ACCOUNT_2, selection("b", 5), 10);
    advance(first, { updated: 7 });
    advance(second, { updated: 4 });

    const job = jobSnapshot(db, "legacy-1");
    expect(job?.total).toBe(10);
    expect(job?.updated).toBe(7);
    expect(job?.done).toBe(7);
  });

  it("under-reports rather than over-reports when every copy has advanced past its baseline", () => {
    // The baseline is stored nowhere, so once no member still holds it the exact
    // job figure (4 + 2 + 3 = 9) is unrecoverable. What is left is a lower bound,
    // and the direction is the point: a progress reading must never claim work
    // that has not happened.
    const first = copiedMember("legacy-1", ACCOUNT, selection("a", 5), 10);
    const second = copiedMember("legacy-1:acc-2", ACCOUNT_2, selection("b", 5), 10);
    advance(first, { updated: 6 });
    advance(second, { updated: 7 });

    const job = jobSnapshot(db, "legacy-1");
    expect(job?.updated).toBe(7);
    expect(job?.done).toBe(7);
    expect(job?.done).toBeLessThanOrEqual(9);
  });

  it("reports a settled job as the whole of its selection, whatever its columns say", () => {
    // A migrated record-only job (a flags acceptance: terminal from the moment it
    // is written) reads `updated 0, failed 0` while being finished. The legacy's
    // settled branch answered `row.total` for exactly this row, and `syncing` --
    // ids with a goal still set -- is nothing to compute once it has ended.
    const first = copiedMember("legacy-1", ACCOUNT, selection("a", 5), 10);
    const second = copiedMember("legacy-1:acc-2", ACCOUNT_2, selection("b", 5), 10);
    settleTask(db, first, "completed", null, 9_000);
    settleTask(db, second, "completed", null, 9_000);

    const job = jobSnapshot(db, "legacy-1");
    expect(job?.status).toBe("completed");
    expect(job?.total).toBe(10);
    expect(job?.done).toBe(10);
    expect(job?.updated).toBe(0);
  });

  it("caps done at the job's total when a member's counters run past it", () => {
    // The three columns are reported as the rows hold them, but `done` is the
    // number a progress bar is drawn from (`SelectionToolbar.tsx:67`), and the
    // counters can sum past `total` even though each one stops at it: a message one
    // attempt delivered and another reported failed is counted in both. A job has
    // never finished more than all of itself, so `7 / 5` is the one reading it must
    // not produce.
    const only = member("job-1", ACCOUNT, selection("a", 5));
    advance(only, { updated: 5, failed: 2 });

    const job = jobSnapshot(db, "job-1");
    expect(job?.total).toBe(5);
    expect(job?.updated).toBe(5);
    expect(job?.failed).toBe(2);
    expect(job?.done).toBe(5);
  });

  it("stops a member's counters at its own total, so no attempt can over-report", () => {
    // The ceiling belongs to `store.ts` and is asserted here because the alias's
    // numbers are what made it necessary: the run timeout abandons an attempt
    // *without stopping it* (`scheduler.ts:156-160`), the chain retries the row, and
    // the abandoned attempt's report lands after the retry's -- both on the same two
    // columns. Unbounded, the partial-failure toast would print an `updated` larger
    // than the job ("4 封操作成功" for a 2-message batch), and `done`'s own clamp
    // cannot save a number the toast reads directly.
    const only = member("job-1", ACCOUNT, selection("a", 2));
    advance(only, { updated: 2 });
    advance(only, { updated: 2 });

    const row = taskRow(db, only);
    expect(row?.updated).toBe(2);
    expect(row?.total).toBe(2);
  });

  it("keeps a running job running until its last member settles", () => {
    const first = member("job-1", ACCOUNT, selection("a", 2));
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    advance(first, { updated: 2 });
    settleTask(db, first, "completed", null, 3_000);

    // One account is done, the other has not started. The job is one user action
    // across accounts, so it is not settled -- but the finished account's ids have
    // stopped being owed, and the reading says so.
    const half = jobSnapshot(db, "job-1");
    expect(half?.status).toBe("running");
    expect(half?.total).toBe(4);
    expect(half?.done).toBe(2);

    advance(second, { updated: 2 });
    settleTask(db, second, "completed", null, 4_000);
    expect(jobSnapshot(db, "job-1")).toMatchObject({ status: "completed", done: 4, updated: 4 });
  });

  it("reports a partly failed job as completed, with the counts that describe it", () => {
    // A mixed member set -- one account finished, the other gave up -- is the
    // legacy's partial failure, and the legacy never wrote `failed` to
    // `batch_jobs.status` (`migrate.ts:442-444`): the renderer's `failed` branch is
    // one generic toast, dropping both counts *and* the one-shot undo that its
    // completed branch offers for exactly this toast (`batchJobRunner.ts:150-157` vs
    // `:183-191`). Reading the set as `failed` would throw away the only feedback
    // that says half the job landed, which post-switch is routine rather than
    // exotic: members are per account, so one account's expired credentials produce
    // it.
    const first = member("job-1", ACCOUNT, selection("a", 3));
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    advance(first, { updated: 3 });
    advance(second, { failed: 2 });
    settleTask(db, first, "completed", null, 3_000);
    settleTask(db, second, "failed", { code: "auth", message: "IMAP said no" }, 3_000);

    const job = jobSnapshot(db, "job-1");
    expect(job).toMatchObject({ status: "completed", total: 5, done: 5, updated: 3, failed: 2 });
    // The reason travels with the numbers rather than replacing them.
    expect(job?.error).toBe("IMAP said no");
  });

  it("reads a settled job as failed only when no part of it got through", () => {
    const first = member("job-1", ACCOUNT, selection("a", 2));
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    settleTask(db, first, "failed", { code: "auth", message: "IMAP said no" }, 3_000);
    settleTask(db, second, "cancelled", null, 3_000);

    // `failed` and `cancelled` are both terminal and neither is a finished write, so
    // the job has nothing in force -- and that is the one reading the renderer's
    // error branch is for.
    expect(jobSnapshot(db, "job-1")).toMatchObject({ status: "failed", total: 4, done: 4, updated: 0 });
  });

  it("resolves a migrated undo job by its own root, member for member", () => {
    // A flags undo is a job of its own: the legacy tracked it as a `batch_jobs` row
    // with `kind: "undo"` (a deleted `batch-jobs.ts:1031` row), and the migration
    // carries it over with the same prefix naming as any other job
    // (`migrate.ts:526-529`), and the renderer polls an undo by the id it was
    // answered with
    // (`batchJobRunner.ts:168-176`). Leaving `undo` out of the member kinds made a
    // cross-account one unresolvable by its own root while each member id answered
    // for a single account -- one job with two answers, neither of them the job.
    const first = undoMember("undo-1", ACCOUNT, selection("a", 2), 4);
    const second = undoMember("undo-1:acc-2", ACCOUNT_2, selection("b", 2), 4);
    settleTask(db, first, "completed", null, 3_000);
    settleTask(db, second, "completed", null, 3_000);

    // The copies' reading (the migration copies the job's numbers into every member),
    // and both entry points agree on the member set -- which is what the root is for.
    expect(jobSnapshot(db, "undo-1")).toMatchObject({ kind: "undo", status: "completed", total: 4, done: 4 });
    expect(jobSnapshot(db, "undo-1:acc-2")).toMatchObject({ id: "undo-1:acc-2", total: 4 });

    // Asking to undo a job whose rows *are* reverses is refused by the kind test,
    // before any claim -- not by the resolution having quietly found one account.
    const { deps } = undoDeps();
    expect(commitJobUndo(deps, "undo-1")).toEqual({ ok: false, reason: "unsupported_parent" });
    expect(undoneOf(first)).toBe(0);
  });

  it("maps the whole task-status vocabulary onto the wire's three values", () => {
    // §8 G11: `pending` must never reach the renderer (its poll reads anything
    // other than `"running"` as settled), and the mapping has to be exhaustive
    // rather than a fallback -- `batchJobRunner.ts:150-190` treats a value it does
    // not recognise as **success**, so a fourth value on the wire would show a
    // "已处理 N 封" toast and an undo button for a job that never happened.
    const table: Array<[TaskStatus, string]> = [
      ["pending", "running"],
      ["running", "running"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "failed"],
      ["unknown_delivery", "failed"],
    ];
    for (const [status, expected] of table) {
      const id = member(`job-${status}`, ACCOUNT, selection(`s-${status}`, 1));
      db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
      expect(jobSnapshot(db, `job-${status}`)?.status, status).toBe(expected);
    }
    // A status this build does not know -- what a row written by a newer build
    // looks like on an older one -- is read as *not settled*: the mapping's two
    // mistakes are not symmetric, because settling early ends the poll on a job
    // that is still writing.
    const unknown = member("job-unknown", ACCOUNT, selection("u", 1));
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run("superseded", unknown);
    expect(jobSnapshot(db, "job-unknown")?.status).toBe("running");
  });

  it("anchors the prefix at the colon, so no job id reaches another's members", () => {
    member("job-1:acc-1", ACCOUNT, selection("a", 3));
    member("job-10:acc-1", ACCOUNT, selection("b", 4));

    // A `LIKE jobId || '%'` would match `job-10`'s member on the first call and
    // would take a `%` from a path segment as a wildcard. `substr` reads neither.
    expect(jobSnapshot(db, "job-1")?.total).toBe(3);
    expect(jobSnapshot(db, "job-10")?.total).toBe(4);
    expect(jobSnapshot(db, "job-1:acc")).toBeNull();
    expect(jobSnapshot(db, "%")).toBeNull();
    expect(jobSnapshot(db, "")).toBeNull();
  });

  it("answers nothing for an id that is no job and no job-like task", () => {
    recordTask(db, MASTER_KEY, { id: "send-1", accountId: ACCOUNT, kind: "send", total: 1 });

    // A send task is not a job in any reading, and the alias's `null` is the
    // route's "批量任务不存在。", so "nothing here" has to mean it.
    expect(jobSnapshot(db, "send-1")).toBeNull();
    expect(jobSnapshot(db, "send-1:acc-1")).toBeNull();
    expect(jobSnapshot(db, "no-such-job")).toBeNull();
  });

  it("treats a lone task as a job of one, which is what the renderer follows", () => {
    // An `undo` task is the reverse of a move job and carries its own id, which is
    // what the renderer polls after pressing undo. It is a job of one, and it is
    // deliberately *not* a member of the job it reverses: the job's aggregate is
    // its forward work.
    const parent = member("job-1", ACCOUNT, selection("a", 2));
    settleTask(db, parent, "completed", null, 3_000);
    const reverse = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "undo",
      parentId: parent,
      total: 2,
      items: selection("a", 2).map((messageId) => ({ messageId, changed: true, originMailbox: ARCHIVE })),
      payload: { target: DESTINATION },
    });

    // `pending` is mapped, not leaked (§8 G11): the renderer's poll reads anything
    // other than `"running"` as settled, so a pending task has to read as running.
    expect(jobSnapshot(db, reverse)).toMatchObject({ id: reverse, kind: "undo", status: "running", total: 2, done: 0 });
    expect(jobSnapshot(db, "job-1")).toMatchObject({ kind: "move", status: "completed", total: 2 });
  });
});

// ---------------------------------------------------------------------------
// The undo
// ---------------------------------------------------------------------------

describe("undoing a job through the alias", () => {
  it("undoes every account's member when asked about one of them", () => {
    const now = 1_000_000;
    const first = member("job-1", ACCOUNT, selection("a", 2));
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    settleTask(db, first, "completed", null, now - 1_000);
    settleTask(db, second, "completed", null, now - 1_000);

    const { deps, started } = undoDeps();
    // Asked about the *second* account's id, which is what the renderer holds when
    // the job was accepted across accounts.
    const outcome = commitJobUndo(deps, "job-1:acc-2", now);
    expect(outcome.ok).toBe(true);
    const created = outcome.ok ? outcome.taskIds : [];

    // One reverse per member, each restoring its own account's selection: undoing
    // only the account that was asked about would leave the other at the
    // destination behind a 200 response.
    expect(created).toHaveLength(2);
    expect(started).toEqual(created);
    expect(undoneOf(first)).toBe(1);
    expect(undoneOf(second)).toBe(1);
    expect(taskRow(db, created[0]!)).toMatchObject({ parent_id: first, kind: "undo", account_id: ACCOUNT });
    expect(itemIds(created[0]!)).toEqual(selection("a", 2));
    expect(taskRow(db, created[1]!)).toMatchObject({ parent_id: second, kind: "undo", account_id: ACCOUNT_2 });
    expect(itemIds(created[1]!)).toEqual(selection("b", 2));
    // And the job now reports itself undone, which is how a client knows an undo
    // it did not follow to the end has already been spent.
    expect(jobSnapshot(db, "job-1:acc-2")?.undone).toBe(true);
  });

  it("claims nothing at all when one member cannot be undone", () => {
    const now = 1_000_000;
    const first = member("job-1", ACCOUNT, selection("a", 2));
    // The second account's task is still executing, so the job is one account
    // short of undoable -- and a fan-out that discovered that at the second member
    // would have spent the first member's claim already.
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    settleTask(db, first, "completed", null, now - 1_000);
    const before = taskIds();

    const { deps, started } = undoDeps();
    expect(commitJobUndo(deps, "job-1", now)).toEqual({ ok: false, reason: "not_completed" });
    expect(undoneOf(first)).toBe(0);
    expect(undoneOf(second)).toBe(0);
    expect(taskIds()).toEqual(before);
    expect(started).toEqual([]);
  });

  it("refuses an expired member without spending the other's open window", () => {
    const now = 1_000_000;
    const first = member("job-1", ACCOUNT, selection("a", 2));
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    settleTask(db, first, "completed", null, now - 1_000);
    settleTask(db, second, "completed", null, now - (TASK_UNDO_WINDOW_MS + 1));

    const { deps } = undoDeps();
    expect(commitJobUndo(deps, "job-1", now)).toEqual({ ok: false, reason: "expired" });
    expect(undoneOf(first)).toBe(0);
    expect(undoneOf(second)).toBe(0);
  });

  it("refuses a member whose inverse cannot be rebuilt, without spending the other's claim", () => {
    // `inverse_unavailable` is read from the *payload* (`kinds/undo.ts`'s
    // `planFlagsUndo`), so it is the one refusal the `undoRefusal` predicate cannot
    // answer. A `{patch}`-only flags parent passes the predicate -- a completed job
    // with an open window -- and fails the plan, so a fan-out whose pre-check stopped
    // at the predicate would have claimed and reversed the *first* account and only
    // then reported the refusal: the user told the undo did not happen while one
    // account's messages were already on their way back. The pre-check is now the
    // same function the claim path answers first, so nothing is claimed.
    const now = 1_000_000;
    const first = member("job-1", ACCOUNT, selection("a", 2));
    const second = recordTask(db, MASTER_KEY, {
      id: "job-1:acc-2",
      accountId: ACCOUNT_2,
      kind: "flags",
      scope: "batch",
      total: 2,
      items: selection("b", 2).map((messageId) => ({ messageId, changed: true })),
      payload: { patch: { seen: true } },
      undoWindowMs: TASK_UNDO_WINDOW_MS,
      now: 1_000,
    });
    settleTask(db, first, "completed", null, now - 1_000);
    settleTask(db, second, "completed", null, now - 1_000);
    const before = taskIds();

    // Resolved in id order, so the member that would have been spent is the clean one.
    const { deps, started } = undoDeps();
    expect(commitJobUndo(deps, "job-1", now)).toEqual({ ok: false, reason: "inverse_unavailable" });
    expect(undoneOf(first)).toBe(0);
    expect(undoneOf(second)).toBe(0);
    expect(taskIds()).toEqual(before);
    expect(started).toEqual([]);
  });

  it("refuses an unreadable member payload before claiming any of them", () => {
    // The half no refusal vocabulary covers: `openPayload` *throws* on an envelope
    // version this build cannot read (`envelope.ts:143-149`). Read during the
    // pre-check, the throw happens before anything is claimed; read inside the loop,
    // every earlier member would already be reversed and the caller would get a 500
    // on top of a half-done undo.
    const now = 1_000_000;
    const first = member("job-1", ACCOUNT, selection("a", 2));
    const second = member("job-1:acc-2", ACCOUNT_2, selection("b", 2));
    db.prepare("UPDATE tasks SET payload_version = 99 WHERE id = ?").run(second);
    settleTask(db, first, "completed", null, now - 1_000);
    settleTask(db, second, "completed", null, now - 1_000);
    const before = taskIds();

    const { deps, started } = undoDeps();
    expect(() => commitJobUndo(deps, "job-1", now)).toThrow(/unsupported envelope version/);
    expect(undoneOf(first)).toBe(0);
    expect(taskIds()).toEqual(before);
    expect(started).toEqual([]);
  });

  it("answers not_found for a job nobody has", () => {
    const { deps } = undoDeps();
    expect(commitJobUndo(deps, "no-such-job")).toEqual({ ok: false, reason: "not_found" });
  });

  it("undoes a lone flags task, whose own frozen payload is the reverse's parent", () => {
    // The shape a flags batch has today: one task per account, no job prefix, and
    // the task the acceptance returns is the one the renderer polls and undoes. Its
    // reverse is a flags write committed by the undo kind itself (`kinds/undo.ts`),
    // which is why the alias needs no branch for it.
    const now = 1_000_000;
    insertMessage(db, "msg-1", 1, INBOX, []);
    const { deps, started } = undoDeps();
    const accepted = db.transaction(() => acceptFlagsTaskInTransaction(deps, {
      messageIds: ["msg-1"],
      patch: { seen: true },
      undoWindowMs: TASK_UNDO_WINDOW_MS,
    }))();
    const parent = accepted.handles[0]!.id;
    settleTask(db, parent, "completed", null, now - 1_000);
    expect(flagsOf("msg-1")).toEqual([SEEN]);

    const outcome = commitJobUndo(deps, parent, now);

    expect(outcome.ok).toBe(true);
    const created = outcome.ok ? outcome.taskIds : [];
    expect(created).toHaveLength(1);
    expect(started).toEqual(created);
    expect(flagsOf("msg-1")).toEqual([]);
    expect(undoneOf(parent)).toBe(1);
    expect(jobSnapshot(db, parent)?.kind).toBe("flags");
  });
});
