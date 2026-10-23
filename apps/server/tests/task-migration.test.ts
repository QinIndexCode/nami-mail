import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// `openDatabase` is a value import here, and every other test in this file drives
// the migration by hand: this is the one place the app's real opening path is the
// subject rather than a stand-in for it.
import { openDatabase, SCHEMA_VERSION, type DatabaseHandle } from "../src/db.js";
import {
  PAYLOAD_ENVELOPE_VERSION,
  PAYLOAD_VERSION_UNSEALED,
  TASK_DEFAULT_MAX_ATTEMPTS,
  commitTask,
  migrateTaskStorageInTransaction,
  openTaskPayload,
  sealMigratedTaskPayloads,
  taskItems,
  taskRow,
  type TaskMigrationResult,
} from "../src/tasks/index.js";
import { TASK_LEGACY_TABLE_DROPS, TASK_MIGRATION_IDS, TASKS_SCHEMA_STATEMENTS } from "../src/tasks/schema.js";
// The *current* opening schema, imported for the same reason the fixture is a
// real dump: the tests at the bottom replay what `db.ts:81` does on the next
// startup, and a stand-in would let the real schema drift away from the thing
// being replayed.
import { NAMI_MAIL_SCHEMA_SQL } from "../src/db-schema.js";
import { MASTER_KEY, countOf, prepareDump, rows, withFixture, writeFixtureFile, WRONG_KEY } from "./helpers/legacy-store.js";

/**
 * Batch 2's migration, run against the frozen pre-batch-2 snapshot.
 *
 * The fixture is a real database written by the *previous* revision's own
 * writers, so this is the zero-loss gate this batch is accepted on: afterwards
 * the three legacy stores are gone and nothing they held has been silently
 * dropped. The five groups the architecture contract's §9 T6 asks for are each
 * a test of their own, so a failure names the loss instead of the migration:
 *
 *   1. every attributable `batch_jobs` row produced at least one `tasks` row;
 *   2. every selection row whose `message_id` still resolves landed in
 *      `task_items` -- 21 of the 24 -- and the three that cannot are named;
 *   3. the cross-account job produced one row per account;
 *   4. a failed run leaves the legacy tables, the markers and the bookkeeping
 *      exactly as they were (the "stamp the new version" half belongs to
 *      `db.test.ts`: nothing can bump `SCHEMA_VERSION` until `db.ts` does);
 *   5. no migrated row pretends work is still owed: the fixture's one legacy
 *      `running` job lands `completed`, its two live push rows land `pending`,
 *      and the four terminal queue rows land nothing at all.
 *
 * Expected numbers are derived from the fixture's rows and the README's
 * boundary table, never from an earlier run of this migration -- a test that
 * asserts what the code just did proves only that it repeats itself. The two
 * synthetic states at the bottom are the exception the contract carves out
 * (§4.3b item 6): shapes the fixture cannot contain but production can, made by
 * editing *rows* in a copy, never the fixture files themselves.
 *
 * `schema.ts`'s lists are imported directly rather than through `index.ts`,
 * which stops at runnable behaviour: what the migration creates, attests to and
 * drops is the migration's own contract. `helpers/legacy-store.ts` owns the
 * loader both this file and the read-back test use.
 */

const ALPHA = "acc-alpha";
const BETA = "acc-beta";

/**
 * The instant every legacy row in the fixture is dated from.
 *
 * Derived from the ISO text rather than copied as `1792205881030`, because the
 * whole point of the fixture's arithmetic traps is that the queue's ISO
 * timestamps and the jobs' INTEGER ones are the same milliseconds -- a number
 * that drifted would still look plausible.
 */
const FIXTURE_INSTANT_ISO = "2026-10-17T02:58:01.030Z";
const FIXTURE_INSTANT = Date.parse(FIXTURE_INSTANT_ISO);
/** `348e5861.completed_at`, the instant `60ecd3c0` (its push row) settled. */
const FLAGS_JOB_COMPLETED_AT = Date.parse("2026-10-17T03:07:01.030Z");
/** `a9fdcd39.completed_at`: the move job settles five minutes after acceptance. */
const MOVE_JOB_COMPLETED_AT = FIXTURE_INSTANT + 5 * 60_000;
/** `d0f5db3e.send_at`, two hours after that row was created. */
const SCHEDULED_SEND_DUE_AT = FIXTURE_INSTANT + 2 * 60 * 60_000;

const QUEUE_UNPUSHED = "cdbda779-2c55-4e8b-a33c-b8cdb1e2017f";
const QUEUE_FAILED = "ce650bfe-b7f9-4c3e-8452-7a413ec7d886";
const QUEUE_SETTLED = "60ecd3c0-ad07-4341-b657-0718f2e5adf9";
const QUEUE_CHUNK_BETA = "6a68c2a6-a7d9-4383-baf0-4d250b285109";
const QUEUE_CHUNK_ALPHA = "bae2a116-2c31-421f-b68d-d906c980b549";
const QUEUE_CLAIMED = "a1675e9c-e347-49b9-9aee-2fcf5283b1b8";
/** The four rows whose outcome the target state already reflects. */
const TERMINAL_QUEUE_ROWS = [QUEUE_FAILED, QUEUE_SETTLED, QUEUE_CHUNK_BETA, QUEUE_CHUNK_ALPHA];

const FLAGS_JOB = "348e5861-78e2-4dfc-9310-ac40a9683543";
const UNDO_JOB = "d1a92e52-4968-43f5-a382-074496c04870";
const MOVE_JOB = "a9fdcd39-76c0-4d58-aee0-4bdf0a230b36";
const GONE_ACCOUNT_JOB = "79b8c7f7-0865-42c0-9c21-38ecd2637849";
const PRUNED_QUEUE_JOB = "b6c094b3-e532-4334-b953-cf68a29665bf";

const SCHEDULED_SEND = "d0f5db3e-7c32-49d1-862c-b7e17486aa77";
const UNSCHEDULED_SEND = "51f75375-6c8e-45f1-a66c-726e9de0bbff";

/** Selection rows whose message went away with the removed account. */
const UNRESOLVABLE_MESSAGE_IDS = ["fx-gamma-inbox-1", "fx-gamma-inbox-2", "fx-gamma-inbox-3"];
const GONE_ACCOUNT_MESSAGE = "fx-gamma-inbox-3";

const FIXTURE_MIGRATION_IDS = [
  "app_settings_intensity_check_0_100",
  "app_settings_sound_check_v2",
  "batch_jobs_move_kind",
  "message-fts-v2",
  "operation_queue_flags_push_kind",
];

/**
 * The markers the *current* build writes outside the task layer.
 *
 * The mount tests at the bottom see these because they open the file through
 * `openDatabase`, which runs every migration step, not just this layer's. Batch
 * 3's column drop is deliberately not in `MIGRATION_MARKERS`: that list is pinned
 * member-for-member to `TASK_MIGRATION_IDS`, and a second step's marker in it
 * would make the pin say something about a list it does not own.
 */
const OTHER_STEP_MIGRATION_IDS = ["folders_drop_counts_v1"];

/** The row production leaves behind when the explicit-id batch move loses its process. */
const IN_FLIGHT_BATCH_MOVE = "0d0a1b2c-3d4e-4f50-8162-738495a6b7c8";

/** The two queue shapes the snapshot has no row for (see the singular-shape test). */
const SINGLE_MOVE_ROW = "1f0a1b2c-3d4e-4f50-8162-738495a6b7c9";
const SINGLE_FLAGS_ROW = "1f0a1b2c-3d4e-4f50-8162-738495a6b7ca";

/**
 * The migration's four markers, spelled out rather than spread from
 * `TASK_MIGRATION_IDS`.
 *
 * A list asserted against itself cannot notice a member being dropped: deleting
 * one from `schema.ts` and from the expectation together would keep this suite
 * green while the guard in `migrateTaskStorageInTransaction` quietly stopped
 * requiring it. That set is all-or-nothing on one transaction by design -- a
 * marker written over a half-applied backfill makes the next startup skip the
 * missing half forever -- so its membership is part of the contract. The two are
 * pinned to each other in the bookkeeping test below.
 */
const MIGRATION_MARKERS = [
  "tasks_backfill_batch_jobs_v1",
  "tasks_backfill_operation_queue_v1",
  "tasks_backfill_scheduled_sends_v1",
  "tasks_table_v1",
];

const taskIds = (db: DatabaseHandle): string[] => db.prepare("SELECT id FROM tasks ORDER BY rowid").pluck().all() as string[];
const messageIdsOf = (db: DatabaseHandle, taskId: string): string[] => taskItems(db, taskId).map((item) => item.message_id);
const itemCount = (db: DatabaseHandle, taskId: string): number =>
  countOf(db, "SELECT COUNT(*) FROM task_items WHERE task_id = ?", taskId);
const tableNames = (db: DatabaseHandle): string[] =>
  rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
const migrationIds = (db: DatabaseHandle): string[] =>
  rows<{ id: string }>(db, "SELECT id FROM data_migrations ORDER BY id").map((row) => row.id);
const legacyPayloadOf = (db: DatabaseHandle, id: string): string =>
  db.prepare("SELECT payload_json FROM operation_queue WHERE id = ?").pluck().get(id) as string;

/** A queue row as the legacy writer left one: the payload column is the task's payload. */
const insertQueueRow = (
  db: DatabaseHandle,
  row: { id: string; accountId: string; kind: string; payload: unknown; status?: string },
): void => {
  db.prepare(`
    INSERT INTO operation_queue (
      id, account_id, kind, payload_json, status, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    row.id,
    row.accountId,
    row.kind,
    JSON.stringify(row.payload),
    row.status ?? "pending",
    FIXTURE_INSTANT_ISO,
    FIXTURE_INSTANT_ISO,
  );
};

/** A fresh fixture, migrated, with the result the migration reported. */
const withMigrated = <T,>(body: (db: DatabaseHandle, result: TaskMigrationResult) => T): T =>
  withFixture((db) => body(db, migrateTaskStorageInTransaction(db)));

describe("task migration: the legacy stores become one tasks table", () => {
  it("carries what it can attribute, leaves the rest, and reports both", () => {
    withMigrated((db, result) => {
      expect(result).toStrictEqual({
        ran: true,
        // Two of six queue rows are unfinished; the four terminal ones carry work
        // whose outcome the user has already been told.
        operationQueue: 2,
        // Four attributable jobs, one of them split across two accounts.
        batchJobs: 5,
        // One pending submission with a `send_at`: scheduling identity. The other
        // two pending rows are immediate work and `unknown_delivery` is not work.
        scheduledSends: 1,
        // Two queue items plus the 21 attributable selection rows.
        items: 23,
        warnings: [`tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`],
      });
      expect(taskIds(db)).toHaveLength(8);
      expect(countOf(db, "SELECT COUNT(*) FROM task_items")).toBe(23);
      // Only the fixture's two surviving accounts. The job whose account was
      // removed must not have invented a third one to hang its row on, and a
      // split member must not be filed under its sibling's account.
      expect(rows<{ account_id: string }>(db, "SELECT DISTINCT account_id FROM tasks ORDER BY account_id"))
        .toEqual([{ account_id: ALPHA }, { account_id: BETA }]);
      // Five finished, three claimable -- group 5's arithmetic in one line.
      expect(rows<{ status: string; count: number }>(db, "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status"))
        .toEqual([{ status: "completed", count: 5 }, { status: "pending", count: 3 }]);
      // `tasks.account_id` and `tasks.parent_id` are real foreign keys, and the
      // split is where a wrong one would land.
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("drops the three legacy stores and leaves the new ones standing", () => {
    // The DROP order is asserted statically because the order itself is not
    // observable: the copy runs before any DROP and both tables are dropped
    // either way, so a reversed list converges on the same schema. The measured
    // reason the order is still written down is that with `foreign_keys = ON`
    // dropping `batch_jobs` fires `batch_job_messages`' ON DELETE CASCADE -- the
    // data is saved by the copy, and no statement may come to depend on that
    // cascade instead.
    const drops = [...TASK_LEGACY_TABLE_DROPS];
    const childDrop = drops.indexOf("DROP TABLE IF EXISTS batch_job_messages");
    const parentDrop = drops.indexOf("DROP TABLE IF EXISTS batch_jobs");
    // Both lookups have to hit, or the comparison below is satisfied by a `-1`:
    // a renamed child DROP would read as "the child is already gone", which is
    // the reverse of what this asserts.
    expect(childDrop).toBeGreaterThanOrEqual(0);
    expect(parentDrop).toBeGreaterThanOrEqual(0);
    expect(childDrop).toBeLessThan(parentDrop);
    // Nothing here may name what the migration just wrote.
    for (const statement of drops) expect(statement).not.toMatch(/\btasks\b|\btask_items\b/);
    // The one-statement-per-entry invariant cannot be asserted from the text --
    // several of the DDL's column comments contain `;`, which is exactly why the
    // list exists instead of a blob that could be split back apart. What enforces
    // it is `db.prepare(...).run()` refusing a two-statement string, so the fact
    // that the migration runs at all is the proof; the split by kind is what
    // catches an index appended to the wrong list.
    expect(TASKS_SCHEMA_STATEMENTS).toHaveLength(7);
    expect(TASKS_SCHEMA_STATEMENTS.filter((s) => s.trimStart().startsWith("CREATE TABLE"))).toHaveLength(2);
    expect(TASKS_SCHEMA_STATEMENTS.filter((s) => s.trimStart().startsWith("CREATE INDEX"))).toHaveLength(5);

    withMigrated((db) => {
      const tables = tableNames(db);
      expect(tables).not.toContain("operation_queue");
      expect(tables).not.toContain("batch_jobs");
      expect(tables).not.toContain("batch_job_messages");
      expect(tables).toContain("tasks");
      expect(tables).toContain("task_items");
      // The ledger is *not* dropped: `kind='send'` registers scheduling identity
      // and points at the row, which owns the sealed request and the key.
      expect(countOf(db, "SELECT COUNT(*) FROM outbound_submissions")).toBe(6);
    });
  });

  it("carries only the unfinished queue rows, transposing `running` to `pending`", () => {
    withFixture((db) => {
      // Read the legacy text first: the claim worth making is "carried verbatim",
      // which only a comparison against the old column can make.
      const carried = new Map([
        [QUEUE_UNPUSHED, legacyPayloadOf(db, QUEUE_UNPUSHED)],
        [QUEUE_CLAIMED, legacyPayloadOf(db, QUEUE_CLAIMED)],
      ]);
      migrateTaskStorageInTransaction(db);

      // The row a crash between the claim and the executor's return leaves
      // behind. `running` is a claim, not a durable task state, so it must not
      // survive verbatim -- while the work it names plainly does.
      expect(taskRow(db, QUEUE_CLAIMED)).toMatchObject({
        account_id: ALPHA,
        kind: "flags",
        scope: "single",
        status: "pending",
        attempt_count: 0,
        max_attempts: TASK_DEFAULT_MAX_ATTEMPTS,
        total: 1,
        updated: 0,
        failed: 0,
        due_at: null,
        next_attempt_at: null,
        completed_at: null,
        created_at: FIXTURE_INSTANT,
        updated_at: FIXTURE_INSTANT,
      });
      expect(messageIdsOf(db, QUEUE_CLAIMED)).toEqual(["fx-alpha-sent-1"]);
      expect(taskRow(db, QUEUE_UNPUSHED)).toMatchObject({ kind: "flags", status: "pending", total: 1 });
      expect(messageIdsOf(db, QUEUE_UNPUSHED)).toEqual(["fx-alpha-inbox-2"]);

      for (const id of [QUEUE_UNPUSHED, QUEUE_CLAIMED]) {
        const task = taskRow(db, id)!;
        // Plaintext on purpose: this is the migration's intermediate state. The
        // master key does not exist inside `migrateDatabase` (the seal pass runs
        // from `app.ts`, after the key is loaded), so a fingerprint -- which is
        // keyed -- cannot be written here either.
        expect(task.payload_ciphertext).toBe(carried.get(id));
        expect(task.payload_version).toBe(PAYLOAD_VERSION_UNSEALED);
        expect(task.payload_fingerprint).toBeNull();
        expect(task.idempotency_key).toBeNull();
        // The payload still names exactly the messages the selection holds.
        const entries = (JSON.parse(task.payload_ciphertext!) as { entries: Array<{ id: string }> }).entries;
        expect(entries.map((entry) => entry.id)).toEqual(messageIdsOf(db, id));
      }

      // The four terminal rows produce nothing at all -- no settled task and no
      // pending one. Two are pushes whose outcome the target state reflects, and
      // two are a move job's executors, whose job row is the task that owns them.
      for (const id of TERMINAL_QUEUE_ROWS) expect(taskRow(db, id)).toBeUndefined();
    });
  });

  it("keeps a job's acceptance-time arithmetic and its selection column for column", () => {
    withMigrated((db) => {
      expect(taskRow(db, FLAGS_JOB)).toMatchObject({
        account_id: ALPHA,
        kind: "flags",
        scope: "batch",
        parent_id: null,
        status: "completed",
        // 8 = 2 changed + 1 refused + 5 already satisfied. The three numbers are
        // acceptance-time buckets, not progress: recomputing them from the
        // selection would erase the only record of the refusal, because those
        // rows keep `failed`'s DDL default of 0.
        total: 8,
        updated: 2,
        failed: 1,
        undone: 1,
        undo_window_ms: 300000,
        // NULL although the status says completed. `undoGuard` measures the
        // five-minute window from `completedAt ?? 0`, so NULL reads as expired --
        // copying the legacy timestamp would make a flags job undoable while its
        // push is still in flight.
        completed_at: null,
        created_at: FIXTURE_INSTANT,
        updated_at: FLAGS_JOB_COMPLETED_AT,
      });
      expect(JSON.parse(taskRow(db, FLAGS_JOB)!.payload_ciphertext!)).toEqual({ patch: { seen: true } });

      const items = taskItems(db, FLAGS_JOB);
      expect(items.map((item) => item.message_id)).toEqual([
        "fx-alpha-inbox-8",
        "fx-alpha-inbox-7",
        "fx-alpha-inbox-6",
        "fx-alpha-inbox-5",
        "fx-alpha-inbox-4",
        "fx-alpha-inbox-3",
        "fx-alpha-inbox-2",
        "fx-alpha-inbox-1",
      ]);
      // `changed` is the selection's one non-zero column and the same set
      // `updated` counts; every row's `failed` stays 0, because the refusal was
      // never written to a selection row.
      expect(items.filter((item) => item.changed === 1).map((item) => item.message_id))
        .toEqual(["fx-alpha-inbox-8", "fx-alpha-inbox-2"]);
      expect(items.filter((item) => item.failed !== 0)).toEqual([]);
      expect(items.find((item) => item.message_id === "fx-alpha-inbox-3")).toMatchObject({ changed: 0, failed: 0 });
    });
  });

  it("links the undo task to the job it reverses, without resurrecting it as live work", () => {
    withMigrated((db) => {
      expect(taskRow(db, UNDO_JOB)).toMatchObject({
        account_id: ALPHA,
        kind: "undo",
        scope: "batch",
        // `parent_id` keeps the legacy meaning -- undo -> the job it reverses --
        // which is why the cross-account siblings of one job are not parented to
        // each other.
        parent_id: FLAGS_JOB,
        // Boundary 9: stored `running` with `completed_at IS NULL` while every
        // queue row it staged is already terminal. Production settles it lazily
        // on the next read, so reading "running" as live work would create a
        // task for something already finished.
        status: "completed",
        completed_at: null,
        total: 2,
        updated: 2,
        failed: 0,
      });
      expect(JSON.parse(taskRow(db, UNDO_JOB)!.payload_ciphertext!)).toEqual({ patch: { seen: false } });
      expect(messageIdsOf(db, UNDO_JOB)).toEqual(["fx-alpha-inbox-8", "fx-alpha-inbox-2"]);
      expect(rows<{ id: string }>(db, "SELECT id FROM tasks WHERE parent_id = ?", FLAGS_JOB).map((row) => row.id))
        .toEqual([UNDO_JOB]);
    });
  });

  it("splits a cross-account job one task per account, keeping every resolvable selection row", () => {
    withMigrated((db) => {
      const alphaTask = `${MOVE_JOB}:${ALPHA}`;
      const betaTask = `${MOVE_JOB}:${BETA}`;
      // The legacy id verbatim when a job belongs to one account, and
      // `jobId:accountId` when it spans accounts -- the shape the compatibility
      // alias resolves by prefix.
      expect(taskRow(db, MOVE_JOB)).toBeUndefined();
      expect(taskRow(db, alphaTask)).toMatchObject({ account_id: ALPHA, kind: "move", scope: "batch", status: "completed" });
      expect(taskRow(db, betaTask)).toMatchObject({ account_id: BETA, kind: "move", scope: "batch", status: "completed" });
      for (const id of [alphaTask, betaTask]) {
        // The job's three numbers, copied column for column into EVERY member.
        // The per-account decomposition was never recorded, so they cannot be
        // split and must not be summed over the members either.
        expect(taskRow(db, id)).toMatchObject({
          total: 11,
          updated: 0,
          failed: 1,
          undo_window_ms: 300000,
          completed_at: MOVE_JOB_COMPLETED_AT,
        });
        expect(JSON.parse(taskRow(db, id)!.payload_ciphertext!)).toEqual({ target: "archive" });
      }

      expect(messageIdsOf(db, alphaTask)).toEqual([
        "fx-alpha-inbox-8",
        "fx-alpha-inbox-7",
        "fx-alpha-inbox-5",
        "fx-alpha-inbox-4",
        "fx-alpha-inbox-3",
        "fx-alpha-inbox-2",
        "fx-alpha-inbox-1",
      ]);
      // Two of the eleven carry the give-up latch (`revertMoveJobFailures`), and
      // the selection's `failed` is a different quantity from the job's -- both
      // survive under their own name and on their own table.
      expect(taskItems(db, betaTask).map((item) => ({ id: item.message_id, changed: item.changed, failed: item.failed })))
        .toEqual([
          { id: "fx-beta-inbox-2", changed: 1, failed: 1 },
          { id: "fx-beta-inbox-1", changed: 1, failed: 1 },
        ]);
      expect(taskItems(db, alphaTask)[0]).toMatchObject({ origin_mailbox: "INBOX", destination_mailbox: "Archive" });

      // 7 + 2 of the job's 11 rows resolve. The minority account is the load-
      // bearing one: attributing the job to a single account would have hung all
      // eleven on alpha and dropped these two on the floor.
      expect(itemCount(db, alphaTask)).toBe(7);
      expect(itemCount(db, betaTask)).toBe(2);
      // The three that cannot resolve are named rather than counted, because a
      // total hides a dropped row behind a row filed under the wrong account.
      for (const gone of UNRESOLVABLE_MESSAGE_IDS) {
        expect(countOf(db, "SELECT COUNT(*) FROM task_items WHERE message_id = ?", gone)).toBe(0);
      }
    });
  });

  it("does not migrate a job it cannot attribute, and records why", () => {
    withMigrated((db, result) => {
      // Removing the third account took the job's queue rows, its messages and
      // its only chance of an account. `tasks.account_id` is NOT NULL, so the
      // honest answers are "warn" or "pick one arbitrarily" -- and the undo
      // window this job offered expired within five minutes of acceptance.
      expect(taskRow(db, GONE_ACCOUNT_JOB)).toBeUndefined();
      expect(countOf(db, "SELECT COUNT(*) FROM tasks WHERE id LIKE ?", `${GONE_ACCOUNT_JOB}%`)).toBe(0);
      expect(result.warnings).toEqual([`tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`]);
      // A warning is a row, not a log line: it lands in the same table as the
      // markers, so an operator sees it without having watched the startup.
      expect(migrationIds(db)).toContain(`tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`);
      expect(countOf(db, "SELECT COUNT(*) FROM task_items WHERE message_id = ?", GONE_ACCOUNT_MESSAGE)).toBe(0);

      // The reverse shape on the same fixture: a job whose queue rows were
      // pruned by predicate while its selection is intact IS migrated, from the
      // selection's own evidence.
      expect(taskRow(db, PRUNED_QUEUE_JOB)).toMatchObject({
        account_id: BETA,
        kind: "move",
        scope: "batch",
        status: "completed",
        total: 2,
      });
      expect(messageIdsOf(db, PRUNED_QUEUE_JOB)).toEqual(["fx-beta-inbox-4", "fx-beta-inbox-3"]);
    });
  });

  it("registers scheduling identity for the scheduled send, and nothing else", () => {
    withMigrated((db) => {
      expect(taskRow(db, SCHEDULED_SEND)).toStrictEqual({
        id: SCHEDULED_SEND,
        account_id: ALPHA,
        kind: "send",
        scope: "single",
        parent_id: null,
        status: "pending",
        // The one derived quantity here, and it needs the full precision:
        // `CAST(strftime('%s', send_at) AS INTEGER) * 1000` would land on the
        // second and lose the fixture's `.030`.
        due_at: SCHEDULED_SEND_DUE_AT,
        next_attempt_at: null,
        attempt_count: 0,
        max_attempts: TASK_DEFAULT_MAX_ATTEMPTS,
        total: 1,
        updated: 0,
        failed: 0,
        // No payload copy: the ledger owns the sealed request, its fingerprint
        // and the message-id uniqueness, and a second ciphertext here would be
        // one more thing to drift.
        payload_ciphertext: null,
        payload_fingerprint: null,
        payload_version: PAYLOAD_ENVELOPE_VERSION,
        idempotency_key: "fixture-scheduled-send",
        undo_window_ms: null,
        undone: 0,
        submission_id: SCHEDULED_SEND,
        error_code: null,
        error_message: null,
        created_at: FIXTURE_INSTANT,
        updated_at: FIXTURE_INSTANT,
        completed_at: null,
      });
      // "No payload" has to stay distinguishable from "an empty payload": the
      // send runner has to tell the ledger's absence from a real one.
      expect(openTaskPayload(MASTER_KEY, taskRow(db, SCHEDULED_SEND)!)).toBeUndefined();
      // A pending submission with no due time waits on the send route, not on
      // the scheduler; `unknown_delivery` is not work at all.
      expect(taskRow(db, UNSCHEDULED_SEND)).toBeUndefined();
      expect(countOf(db, "SELECT COUNT(*) FROM tasks WHERE kind = 'send'")).toBe(1);
      // The ledger itself is untouched, statuses included.
      expect(rows<{ status: string; count: number }>(db, "SELECT status, COUNT(*) AS count FROM outbound_submissions GROUP BY status ORDER BY status"))
        .toEqual([
          { status: "confirmed", count: 1 },
          { status: "failed", count: 1 },
          { status: "pending", count: 3 },
          { status: "unknown_delivery", count: 1 },
        ]);
    });
  });

  it("reads the bookkeeping it finds, adds only its own rows, and stops after one run", () => {
    withMigrated((db) => {
      const expectedIds = [
        ...FIXTURE_MIGRATION_IDS,
        ...MIGRATION_MARKERS,
        `tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`,
      ].sort();
      // The literal above and the module's list are pinned to each other, so
      // dropping a marker from `schema.ts` fails here rather than loosening the
      // guard the migration reads.
      expect([...TASK_MIGRATION_IDS].sort()).toEqual(MIGRATION_MARKERS);
      expect(migrationIds(db)).toEqual(expectedIds);
      // The five pre-existing ids keep their own stamps: the migration has no
      // business rewriting another step's attestation.
      const stamps = new Map(
        rows<{ id: string; completed_at: string }>(db, "SELECT id, completed_at FROM data_migrations").map((row) => [row.id, row.completed_at]),
      );
      for (const id of FIXTURE_MIGRATION_IDS) expect(stamps.get(id)).toBe(FIXTURE_INSTANT_ISO);
      // `schema_meta` is not this migration's to touch; bumping the version is
      // `db.ts`'s step, in the same transaction as the mount.
      expect(rows(db, "SELECT key, value FROM schema_meta")).toEqual([{ key: "schema_version", value: "1" }]);

      // A second run is a no-op that says so, not a second backfill. The markers
      // test for *all four* for this reason: a half-applied backfill that had
      // written one marker would be skipped forever.
      //
      // `toStrictEqual` rather than `toEqual` throughout this file's row-shape
      // assertions: `toEqual` treats an absent key as equal to one holding
      // `undefined`, so a field dropped from a report (or from `mapTaskRow`)
      // would pass silently -- the exact lesson §9.1 records for the provider
      // spec objects.
      const tasksAfterFirstRun = taskIds(db);
      expect(migrateTaskStorageInTransaction(db))
        .toStrictEqual({ ran: false, operationQueue: 0, batchJobs: 0, scheduledSends: 0, items: 0, warnings: [] });
      expect(taskIds(db)).toEqual(tasksAfterFirstRun);
      expect(countOf(db, "SELECT COUNT(*) FROM task_items")).toBe(23);
      expect(migrationIds(db)).toEqual(expectedIds);
    });
  });

  it("leaves the legacy database exactly as it was when the caller's transaction fails", () => {
    withFixture((db) => {
      const inventory = () => ({
        operation_queue: countOf(db, "SELECT COUNT(*) FROM operation_queue"),
        batch_jobs: countOf(db, "SELECT COUNT(*) FROM batch_jobs"),
        batch_job_messages: countOf(db, "SELECT COUNT(*) FROM batch_job_messages"),
        data_migrations: countOf(db, "SELECT COUNT(*) FROM data_migrations"),
      });
      const before = inventory();
      // The migration runs inside whatever transaction the caller opened, so a
      // failure after it must discard the DDL, the three backfills, the four
      // markers and the DROPs together. The alternative -- tables created and
      // markers written over a half-applied backfill -- is the state where the
      // next startup sees "migrated" and loses the missing half for good.
      expect(() => db.transaction(() => {
        migrateTaskStorageInTransaction(db);
        throw new Error("mount failed after the migration");
      })()).toThrow("mount failed after the migration");

      expect(inventory()).toEqual(before);
      expect(tableNames(db)).toContain("operation_queue");
      expect(tableNames(db)).not.toContain("tasks");
      expect(migrationIds(db)).toEqual(FIXTURE_MIGRATION_IDS);
      expect(rows(db, "SELECT key, value FROM schema_meta")).toEqual([{ key: "schema_version", value: "1" }]);
    });
  });
});

describe("task migration: the seal pass that needs the master key", () => {
  /** The seven rows the backfill wrote as plaintext. */
  const UNSEALED = [
    QUEUE_UNPUSHED,
    QUEUE_CLAIMED,
    FLAGS_JOB,
    UNDO_JOB,
    `${MOVE_JOB}:${ALPHA}`,
    `${MOVE_JOB}:${BETA}`,
    PRUNED_QUEUE_JOB,
  ];

  it("rewrites every backfilled payload as an envelope that opens to the same value", () => {
    withMigrated((db) => {
      const plaintext = new Map<string, unknown>();
      for (const id of UNSEALED) {
        const task = taskRow(db, id)!;
        expect(task.payload_version).toBe(PAYLOAD_VERSION_UNSEALED);
        plaintext.set(id, JSON.parse(task.payload_ciphertext!));
      }
      // Nothing else is waiting to be sealed, and the version-0 selection is
      // exactly the backfill's output rather than "every row with a payload".
      expect(countOf(db, "SELECT COUNT(*) FROM tasks WHERE payload_version = ?", PAYLOAD_VERSION_UNSEALED)).toBe(UNSEALED.length);

      expect(sealMigratedTaskPayloads(db, MASTER_KEY)).toBe(UNSEALED.length);
      for (const id of UNSEALED) {
        const task = taskRow(db, id)!;
        expect(task.payload_version).toBe(PAYLOAD_ENVELOPE_VERSION);
        expect(task.payload_fingerprint).toMatch(/^h1\./);
        // The column now holds an envelope rather than the legacy plaintext, and
        // it opens under the key that sealed it and fails under any other.
        expect(task.payload_ciphertext).toMatch(/^nami-v1\./);
        expect(openTaskPayload(MASTER_KEY, task)).toEqual(plaintext.get(id));
        expect(() => openTaskPayload(WRONG_KEY, task)).toThrow();
      }

      // The payload-free row is not a candidate, and stays that way.
      const send = taskRow(db, SCHEDULED_SEND)!;
      expect(send.payload_version).toBe(PAYLOAD_ENVELOPE_VERSION);
      expect(send.payload_ciphertext).toBeNull();
      expect(openTaskPayload(MASTER_KEY, send)).toBeUndefined();
    });
  });

  it("is idempotent, so a failed startup is retried rather than frozen", () => {
    withMigrated((db) => {
      expect(sealMigratedTaskPayloads(db, MASTER_KEY)).toBe(7);
      const sealed = new Map(UNSEALED.map((id) => [id, taskRow(db, id)!.payload_ciphertext]));
      // A second pass finds nothing: the selection is `payload_version = 0`, and
      // the UPDATE re-tests it so a concurrently sealed row is not rewritten
      // with a second, equal envelope.
      expect(sealMigratedTaskPayloads(db, MASTER_KEY)).toBe(0);
      for (const id of UNSEALED) expect(taskRow(db, id)!.payload_ciphertext).toBe(sealed.get(id));
    });
  });

  it("binds each envelope to the row it was sealed for", () => {
    withMigrated((db) => {
      sealMigratedTaskPayloads(db, MASTER_KEY);
      const task = taskRow(db, QUEUE_UNPUSHED)!;
      // Control: the untouched row opens, so the two refusals below are about
      // the associated data and not about a key mismatch.
      expect(openTaskPayload(MASTER_KEY, task)).toBeDefined();

      // The id and the account are in the AAD, so a ciphertext lifted onto a
      // neighbouring row -- or replayed under another account, which is how one
      // user's payload could surface in another's chain -- must not open even
      // with the right key. The wrong-key case above does not cover this: the
      // key is the same one here.
      expect(() => openTaskPayload(MASTER_KEY, { ...task, id: QUEUE_CLAIMED })).toThrow();
      expect(() => openTaskPayload(MASTER_KEY, { ...task, account_id: BETA })).toThrow();
    });
  });
});

describe("task migration: the two synthetic states the fixture cannot hold (§4.3b item 6)", () => {
  it("makes a task of a batch-move row that carries ids, and never of a job's chunk", () => {
    withFixture((db) => {
      // Written the way production leaves it: the explicit-id batch move is a
      // queued row of its own, and the row a live job staged is still claimable.
      db.prepare(`
        INSERT INTO operation_queue (
          id, account_id, kind, payload_json, status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        IN_FLIGHT_BATCH_MOVE,
        BETA,
        "batch-move",
        JSON.stringify({ ids: ["fx-beta-inbox-3", "fx-beta-inbox-4"], target: "archive" }),
        "pending",
        0,
        FIXTURE_INSTANT_ISO,
        FIXTURE_INSTANT_ISO,
      );
      db.prepare("UPDATE operation_queue SET status = 'pending' WHERE id = ?").run(QUEUE_CHUNK_ALPHA);

      const result = migrateTaskStorageInTransaction(db);

      // Same `kind`, two shapes: the discriminant is `jobId` in the payload. The
      // explicit-id route is the task itself -- and it is the row the old build
      // would have re-driven after a restart, so dropping it would be a batch
      // move that silently never happens.
      expect(taskRow(db, IN_FLIGHT_BATCH_MOVE)).toMatchObject({
        account_id: BETA,
        kind: "move",
        scope: "batch",
        status: "pending",
        total: 2,
      });
      expect(messageIdsOf(db, IN_FLIGHT_BATCH_MOVE)).toEqual(["fx-beta-inbox-3", "fx-beta-inbox-4"]);

      // The chunk row carries no message ids at all -- it is an executor, and its
      // job row is the task that owns the work. Migrating it too would give one
      // piece of remote work two executable tasks.
      expect(taskRow(db, QUEUE_CHUNK_ALPHA)).toBeUndefined();
      // But it *is* evidence, on two counts: it names the accounts the job
      // touches, and being non-terminal it says the job still has an executor.
      expect(taskRow(db, `${MOVE_JOB}:${ALPHA}`)!.status).toBe("pending");
      expect(taskRow(db, `${MOVE_JOB}:${BETA}`)!.status).toBe("pending");
      // Per job, not global: the neighbouring move job has no queue row left to
      // speak for it, so it stays as settled as it was.
      expect(taskRow(db, PRUNED_QUEUE_JOB)!.status).toBe("completed");

      expect(result.operationQueue).toBe(3);
      expect(result.items).toBe(25);
      expect(result.warnings).toEqual([`tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`]);
    });
  });

  it("keeps an in-flight push and the flags job it executes as two identities, only one of them live", () => {
    withFixture((db) => {
      // The shape `acceptFlagsJob` leaves when the process dies after the commit
      // and before the push returns: the executor row is claimable again, and the
      // job row is still on `running`.
      db.prepare("UPDATE operation_queue SET status = 'pending' WHERE id = ?").run(QUEUE_FAILED);
      db.prepare("UPDATE batch_jobs SET status = 'running' WHERE id = ?").run(FLAGS_JOB);

      migrateTaskStorageInTransaction(db);

      // ① The executor side: a real, live `flags` task whose payload is the
      // push's `{accountId, entries}`.
      expect(taskRow(db, QUEUE_FAILED)).toMatchObject({
        account_id: ALPHA,
        kind: "flags",
        scope: "batch",
        status: "pending",
        total: 2,
      });
      expect(messageIdsOf(db, QUEUE_FAILED)).toEqual(["fx-alpha-inbox-8", "fx-alpha-inbox-2"]);

      // ② The record side: `running` in the legacy table, `completed` here. The
      // executor was migrated into a task of its own, so the job is only the
      // record of an acceptance -- making it claimable too would run the same
      // STORE twice. Its own selection is untouched by that decision: all eight
      // rows and the acceptance-time arithmetic are still its own.
      const record = taskRow(db, FLAGS_JOB)!;
      expect(record).toMatchObject({ kind: "flags", scope: "batch", status: "completed", completed_at: null, total: 8, updated: 2, failed: 1 });
      expect(JSON.parse(record.payload_ciphertext!)).toEqual({ patch: { seen: true } });
      expect(messageIdsOf(db, FLAGS_JOB)).toHaveLength(8);

      // ③ Two identities, one piece of work: the messages the push will push are
      // exactly the selection rows the job counted as changed. That correspondence
      // is why the two rows must not both be executable.
      const pushed = new Set(messageIdsOf(db, QUEUE_FAILED));
      const changed = new Set(taskItems(db, FLAGS_JOB).filter((item) => item.changed === 1).map((item) => item.message_id));
      expect(pushed).toEqual(changed);
      // And no third row appeared for either: the two ids did not collapse into
      // one task, nor multiply into more.
      expect(countOf(db, "SELECT COUNT(*) FROM tasks WHERE id IN (?, ?)", QUEUE_FAILED, FLAGS_JOB)).toBe(2);
    });
  });

  it("turns an unparsable job payload into a warning, and its undo into a named orphan", () => {
    withFixture((db) => {
      // A `patch_json` that is not JSON. This is the sibling of the queue's own
      // guarded parse: one corrupt row must cost one row, not the whole run --
      // before the guard in `planJob` this threw out of the migration and the
      // startup would have failed on a file the app had been booting from.
      db.prepare("UPDATE batch_jobs SET patch_json = ? WHERE id = ?").run("{not json", FLAGS_JOB);

      const result = migrateTaskStorageInTransaction(db);

      expect(taskRow(db, FLAGS_JOB)).toBeUndefined();
      // Migrated-with-an-empty-payload would be worse than not migrated: the row
      // would look runnable and the runner would have nothing to apply. So the
      // eight selection rows go too, and the item total says so.
      expect(result.items).toBe(15);
      expect(result.batchJobs).toBe(4);
      expect(result.warnings).toHaveLength(3);
      expect(result.warnings).toContain(`tasks_unreadable_batch_job:${FLAGS_JOB}`);
      // A warning is a row, not a log line -- the same table the markers live in.
      expect(migrationIds(db)).toContain(`tasks_unreadable_batch_job:${FLAGS_JOB}`);

      // The undo row reverses a job that no longer exists, so the link cannot be
      // made. Losing the link is the smaller loss and the row itself is still
      // carried -- with `parent_id` NULL rather than pointing at a row that was
      // never written, which would be a foreign-key violation (the check below).
      expect(taskRow(db, UNDO_JOB)).toMatchObject({ kind: "undo", status: "completed", parent_id: null });
      expect(result.warnings).toContain(`tasks_orphan_undo:${UNDO_JOB}`);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("carries a single-message move and a singular flags payload, which no snapshot row takes", () => {
    withFixture((db) => {
      // Neither shape is in the snapshot: production's flag pushes go through
      // `flags-push` (`{accountId, entries}`) and its moves through `batch-move`.
      // Both are still legal in the old CHECK and both had a registered runner
      // (`app.ts:324`, `app.ts:341`), so an older database can carry them -- and
      // the singular spellings are the only path that exercises `planQueueTask`'s
      // `move` branch and `flagMessageIds`'s `messageId` fallback.
      insertQueueRow(db, {
        id: SINGLE_MOVE_ROW,
        accountId: BETA,
        kind: "move",
        payload: { messageId: "fx-beta-inbox-1", target: "archive" },
      });
      insertQueueRow(db, {
        id: SINGLE_FLAGS_ROW,
        accountId: ALPHA,
        kind: "flags",
        payload: { messageId: "fx-alpha-inbox-1", patch: { seen: true } },
      });

      const result = migrateTaskStorageInTransaction(db);

      expect(taskRow(db, SINGLE_MOVE_ROW)).toMatchObject({
        account_id: BETA,
        kind: "move",
        scope: "single",
        status: "pending",
        total: 1,
      });
      expect(messageIdsOf(db, SINGLE_MOVE_ROW)).toEqual(["fx-beta-inbox-1"]);
      expect(taskRow(db, SINGLE_FLAGS_ROW)).toMatchObject({
        account_id: ALPHA,
        kind: "flags",
        scope: "single",
        status: "pending",
        total: 1,
      });
      expect(messageIdsOf(db, SINGLE_FLAGS_ROW)).toEqual(["fx-alpha-inbox-1"]);
      // A queue task's ciphertext is the legacy column verbatim, whatever the
      // plan made of it -- so a `flags` task can hold either payload spelling and
      // its runner has to accept both. Asserting the whole object is what pins
      // that: `{patch}` alone would be a shape no legacy row ever had.
      expect(JSON.parse(taskRow(db, SINGLE_FLAGS_ROW)!.payload_ciphertext!))
        .toEqual({ messageId: "fx-alpha-inbox-1", patch: { seen: true } });
      expect(JSON.parse(taskRow(db, SINGLE_MOVE_ROW)!.payload_ciphertext!))
        .toEqual({ messageId: "fx-beta-inbox-1", target: "archive" });
      expect(result.operationQueue).toBe(4);
      expect(result.warnings).toEqual([`tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`]);
    });
  });

  it("splits a cross-account job from its selection alone when no queue row survives", () => {
    withFixture((db) => {
      // The union the attribution is built from (§3.4.1) has two sides: the
      // queue rows' `jobId`+`accountId` evidence and the reverse resolution of
      // the job's own selection rows. The snapshot has a job with evidence and
      // no selection (`PRUNED_QUEUE_JOB`'s shape, covered above) and a job with
      // neither (`GONE_ACCOUNT_JOB`). What it never exercises is a job whose
      // evidence is gone but whose selection is intact *and spans accounts* --
      // which is where "attribute the job to one account" would hide: all
      // eleven rows would land on the first account found and two would vanish
      // with no count to notice it.
      db.prepare("DELETE FROM operation_queue WHERE id IN (?, ?)").run(QUEUE_CHUNK_ALPHA, QUEUE_CHUNK_BETA);

      const result = migrateTaskStorageInTransaction(db);

      expect(result.batchJobs).toBe(5);
      expect(taskRow(db, `${MOVE_JOB}:${ALPHA}`)).toMatchObject({ account_id: ALPHA, status: "completed" });
      expect(taskRow(db, `${MOVE_JOB}:${BETA}`)).toMatchObject({ account_id: BETA, status: "completed" });
      expect(itemCount(db, `${MOVE_JOB}:${ALPHA}`)).toBe(7);
      expect(itemCount(db, `${MOVE_JOB}:${BETA}`)).toBe(2);
      expect(countOf(db, "SELECT COUNT(*) FROM tasks")).toBe(8);
    });
  });
});

/**
 * The mount and the DDL removal are one change, executed rather than argued --
 * and these two tests are that change's landing evidence, in the direction it
 * now runs.
 *
 * `migrateTaskStorageInTransaction` runs once, guarded by four markers, and
 * `insertTaskRow` is a bare `INSERT`, so the backfill is a *snapshot*: nothing
 * re-reads the legacy rows on a later startup. That is what makes its `DROP`
 * durable only if the next startup stops recreating the store, and
 * `db.exec(schema)` re-applies the opening schema on *every* open, not only on a
 * fresh file.
 *
 * Both tests were written in the opposite direction before batch 4 landed and
 * were flipped by it, exactly as the counts guardrails' T1/T3/T5 were. The first
 * used to watch the reopen put the three stores back as empty tables; it now
 * watches them stay gone, which is the property the DROP needed all along. The
 * second used to watch a retired writer crash on a table the migration had just
 * dropped; the retired writers are deleted now, so it watches the replacement
 * write to the same file while nothing can name the old tables at all. A green
 * run here is only meaningful because both failed before the flip.
 */
describe("task migration: the DROP is durable because the opening schema stopped declaring the store", () => {
  it("leaves the dropped stores absent on the next open instead of recreating them", () => {
    withMigrated((db) => {
      expect(tableNames(db)).not.toContain("operation_queue");
      expect(tableNames(db)).not.toContain("batch_jobs");
      expect(tableNames(db)).not.toContain("batch_job_messages");
      const tasksAfterMigration = taskIds(db);

      // The next startup, verbatim: the opening schema is dumped over whatever
      // the file already holds. It no longer names these three, so "dropped"
      // stays dropped -- the opposite of what this test asserted while the DDL
      // still declared them, and the reason the DROP may live in the migration
      // at all rather than having to be hoisted into the open path.
      prepareDump(db, NAMI_MAIL_SCHEMA_SQL);

      expect(tableNames(db)).not.toContain("operation_queue");
      expect(tableNames(db)).not.toContain("batch_jobs");
      expect(tableNames(db)).not.toContain("batch_job_messages");
      expect(taskIds(db)).toEqual(tasksAfterMigration);

      // The guard still holds, so no later open re-runs the backfill against a
      // store that no longer exists.
      expect(migrateTaskStorageInTransaction(db))
        .toStrictEqual({ ran: false, operationQueue: 0, batchJobs: 0, scheduledSends: 0, items: 0, warnings: [] });
      expect(tableNames(db)).not.toContain("operation_queue");
      expect(taskIds(db)).toEqual(tasksAfterMigration);
    });
  });

  it("adds the acceptance-time UID columns to a table that predates them, past the marker check", () => {
    // A v3 file: the table exists with that release's columns and nothing else.
    // The migration markers are present too, so the backfill returns early -- and
    // the column guard has to run ahead of that return, or an upgraded file would
    // never get the pair and every queued write would be judged "unproven".
    const db = openDatabase(":memory:");
    try {
      db.prepare("DROP TABLE task_items").run();
      db.prepare(`
        CREATE TABLE task_items (
          task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          message_id          TEXT NOT NULL,
          changed             INTEGER NOT NULL DEFAULT 0,
          origin_mailbox      TEXT,
          destination_mailbox TEXT,
          failed              INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (task_id, message_id)
        )
      `).run();

      expect(migrateTaskStorageInTransaction(db))
        .toStrictEqual({ ran: false, operationQueue: 0, batchJobs: 0, scheduledSends: 0, items: 0, warnings: [] });

      const columns = db.prepare("PRAGMA table_info(task_items)").all() as Array<{ name: string; type: string }>;
      expect(columns.filter((column) => column.name === "origin_uid").map((column) => column.type)).toEqual(["INTEGER"]);
      expect(columns.filter((column) => column.name === "origin_uid_validity").map((column) => column.type)).toEqual(["TEXT"]);
    } finally {
      db.close();
    }
  });

  it("has no writer left to name those stores, while the replacement writes to the same file", () => {
    withMigrated((db) => {
      // The pre-landing pin proved the *mount alone* was a crash: two writers in
      // the request path prepared statements against tables the migration had
      // just dropped, so the drop could not land before the writers switched.
      // Both writers are deleted (the static half of that is
      // `tests/legacy-layer-removal.test.ts`), so what remains to prove is the
      // other side of the same edge: a statement naming a retired store cannot be
      // prepared on a migrated database, and the writer that replaced them needs
      // no such table.
      expect(() => insertQueueRow(db, { id: QUEUE_UNPUSHED, accountId: ALPHA, kind: "flags-push", payload: {} }))
        .toThrow(/no such table: operation_queue/);
      expect(() => db.prepare("INSERT INTO batch_jobs (id, kind, patch_json, target, status) VALUES (?, 'move', '{}', '{}', 'running')").run(QUEUE_UNPUSHED))
        .toThrow(/no such table: batch_jobs/);

      const started: string[] = [];
      const handle = commitTask(
        { db, masterKey: MASTER_KEY, scheduler: { start: (id: string) => started.push(id) } },
        {
          accountId: ALPHA,
          kind: "flags",
          scope: "single",
          total: 1,
          items: [{ messageId: "message-1", changed: true }],
          payload: { ids: ["message-1"], patch: { seen: true } },
        },
      );
      handle.start();
      expect(taskRow(db, handle.id)).toMatchObject({ account_id: ALPHA, kind: "flags", status: "pending" });
      expect(started).toEqual([handle.id]);
    });
  });
});

/**
 * The mount itself, executed the way the app executes it.
 *
 * Every test above calls `migrateTaskStorageInTransaction` by hand. That is the
 * right subject for what the migration *does*, but it cannot see the one thing
 * 4b added to the open path: whether `migrateDatabase` still calls it at all, and
 * whether the call still sits where its three input columns exist. A test that
 * calls the function directly stays green through a deleted call site.
 *
 * So these two open a real file with the real `openDatabase`: the pragmas, the
 * opening schema, `migrateDatabase` and the version stamp, inside the one
 * transaction `db.ts` opens for them. The file is the fixture written out
 * verbatim (`writeFixtureFile`), i.e. a database as the *previous* revision left
 * one -- `schema_version` = 1, the three legacy stores still declared and full,
 * and a `send_at` on a parked submission. That the whole chain accepts a file it
 * did not write is the property this pair exists to hold down. (That the fixture
 * really is that shape, and that its stamp really is v1, is pinned once in
 * `legacy-store-fixture.test.ts`; repeating it here would give the same fact two
 * owners and let them drift.)
 *
 * What is *not* here: the seal. `sealMigratedTaskPayloads` needs the master key,
 * which the opening path does not have, so a migrated payload is authenticated
 * but still plaintext until `app.ts` seals it -- asserted below, because the
 * boundary between those two moments is exactly where "the migration is done"
 * could get confused with "the rows are usable".
 */
describe("task migration: the mount, run through the real opening path", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  /** A fixture file in a directory this suite owns, plus the path to it. */
  function fixtureOnDisk(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-task-mount-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    writeFixtureFile(databasePath);
    return databasePath;
  }

  /** Everything the migration is expected to have attested to, once and once only. */
  const expectedMigrationIds = [
    ...FIXTURE_MIGRATION_IDS,
    ...MIGRATION_MARKERS,
    ...OTHER_STEP_MIGRATION_IDS,
    `tasks_unattributable_batch_job:${GONE_ACCOUNT_JOB}`,
  ].sort();

  /** The seven backfilled rows whose payload is still plaintext until `app.ts` seals it. */
  const UNSEALED_AFTER_OPEN = 7;

  it("migrates a legacy file, drops the three stores and stamps the new version", () => {
    const databasePath = fixtureOnDisk();

    const db = openDatabase(databasePath);
    try {
      // The DROP, and the same DDL that has to keep it dropped on every later
      // open: `db.exec(schema)` ran a moment ago and did not recreate them.
      const tables = tableNames(db);
      for (const gone of ["operation_queue", "batch_jobs", "batch_job_messages"]) expect(tables).not.toContain(gone);
      expect(tables).toContain("tasks");
      expect(tables).toContain("task_items");

      // The backfill's own arithmetic, unchanged from the hand-driven tests --
      // which is the point: the same migration, reached through the real path.
      expect(countOf(db, "SELECT COUNT(*) FROM tasks")).toBe(8);
      expect(countOf(db, "SELECT COUNT(*) FROM task_items")).toBe(23);
      expect(taskIds(db)).toHaveLength(8);
      expect(migrationIds(db)).toEqual(expectedMigrationIds);
      // The stamp and the migration are one transaction (`db.ts`), so this is a
      // file the migration already ran on. The stamp is the build's own
      // `SCHEMA_VERSION`; `db.test.ts` owns the bump itself, and this is what
      // catches a bump that forgot the databases already out there.
      expect(rows(db, "SELECT key, value FROM schema_meta")).toEqual([{ key: "schema_version", value: String(SCHEMA_VERSION) }]);

      // The scheduled send is the row the migration has to get exactly right,
      // because `due_at` is what the scheduler's claim predicate compares: the
      // fixture's `send_at` (`.030` included) is the task's due instant, and the
      // task's id is the submission's so the cancel route can find it.
      expect(taskRow(db, SCHEDULED_SEND)).toMatchObject({
        kind: "send",
        scope: "single",
        status: "pending",
        due_at: SCHEDULED_SEND_DUE_AT,
        submission_id: SCHEDULED_SEND,
        total: 1,
        attempt_count: 0,
        next_attempt_at: null,
      });

      // Authenticated, not sealed: the version-0 selection is still the whole
      // backfill output, so the opening path did not quietly seal part of it.
      expect(countOf(db, "SELECT COUNT(*) FROM tasks WHERE payload_version = ?", PAYLOAD_VERSION_UNSEALED)).toBe(UNSEALED_AFTER_OPEN);
      expect(taskRow(db, SCHEDULED_SEND)!.payload_ciphertext).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not migrate twice or resurrect the stores on the next open of that file", () => {
    const databasePath = fixtureOnDisk();
    const first = openDatabase(databasePath);
    const tasksAfterFirstOpen = taskIds(first);
    first.close();

    // The second launch, on the file the first one migrated and stamped.
    const second = openDatabase(databasePath);
    try {
      const tables = tableNames(second);
      for (const gone of ["operation_queue", "batch_jobs", "batch_job_messages"]) expect(tables).not.toContain(gone);
      // Same rows, same ids, same order: the markers held, so no row was written
      // twice and no legacy row was re-read from a store that no longer exists.
      expect(taskIds(second)).toEqual(tasksAfterFirstOpen);
      expect(countOf(second, "SELECT COUNT(*) FROM task_items")).toBe(23);
      expect(migrationIds(second)).toEqual(expectedMigrationIds);
      // Still the same stamp: the second open had nothing to migrate, so it wrote
      // neither a row nor a different version.
      expect(rows(second, "SELECT key, value FROM schema_meta")).toEqual([{ key: "schema_version", value: String(SCHEMA_VERSION) }]);
      // And the schedule survives the restart as a schedule: the parked mail is
      // still parked at the instant the user picked, which is what the scheduler
      // claims it by on this launch. A migration that got this right only until
      // the file was reopened would be a mail that never goes out.
      expect(taskRow(second, SCHEDULED_SEND)).toMatchObject({
        status: "pending",
        due_at: SCHEDULED_SEND_DUE_AT,
        next_attempt_at: null,
        attempt_count: 0,
      });
      // Still unsealed, because the seal is `app.ts`'s and nothing in the open
      // path may have started doing it.
      expect(countOf(second, "SELECT COUNT(*) FROM tasks WHERE payload_version = ?", PAYLOAD_VERSION_UNSEALED)).toBe(UNSEALED_AFTER_OPEN);
    } finally {
      second.close();
    }
  });
});
