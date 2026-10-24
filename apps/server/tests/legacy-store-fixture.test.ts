import { describe, expect, it } from "vitest";
import { messagePayloadForRow, type MessageStorageRow } from "../src/message-storage.js";
import { countOf, fixtureSchemaSql as schemaSql, MASTER_KEY, rows, statementsOf, withFixture, WRONG_KEY } from "./helpers/legacy-store.js";

/**
 * Read-back test for `fixtures/legacy-store-2026-10` — the frozen snapshot of
 * the store as it was BEFORE batch 2.
 *
 * It runs no migration and asserts no new behaviour. Its job is the negative
 * one: prove the snapshot is still a *legacy* database (folder counters present,
 * no `tasks`) and that every boundary row batch 2's migration and batch 3's
 * column-drop will be validated against is actually there, with the arithmetic
 * the README documents. The migration itself is `task-migration.test.ts`; this
 * file fails loudly when a regeneration quietly moves the baseline out from
 * under it.
 */

/** FTS5's own storage; deliberately absent from the dump, so a loaded fixture has none. */
const FTS_SHADOW_PREFIX = "messages_fts_";

describe("the dump splitter", () => {
  it("keeps terminators inside strings, comments and trigger bodies", () => {
    const sql = [
      "-- a comment with an apostrophe: messages_fts's own statement;",
      "CREATE TABLE demo (a TEXT DEFAULT 'semi;colon', b TEXT DEFAULT 'it''s');",
      "CREATE TRIGGER demo_after_delete AFTER DELETE ON demo BEGIN",
      "  DELETE FROM demo WHERE a = 'x;y';",
      "END;",
      "INSERT INTO demo (a) VALUES ('--not a comment');",
    ].join("\n");
    const statements = statementsOf(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("DELETE FROM demo WHERE a = 'x;y';");
    expect(statements[2]).toContain("'--not a comment'");
  });
});

describe("legacy store fixture — read back without migrating", () => {
  it("loads as a legacy database, and nothing in the load has migrated it", () => {
    withFixture((db) => {
      expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const tables = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
      const shadowTables = tables.filter((name) => name.startsWith(FTS_SHADOW_PREFIX));
      // FTS5's index tables exist here because `CREATE VIRTUAL TABLE` creates
      // them — SQLite refuses to let them be created by hand, so the dump must
      // omit them (asserted against the dump's own text) and their presence is
      // evidence that `messages_fts`'s statement ran rather than the dump being
      // taken as written.
      expect(shadowTables).toEqual([
        "messages_fts_config",
        "messages_fts_content",
        "messages_fts_data",
        "messages_fts_docsize",
        "messages_fts_idx",
      ]);
      expect(tables.filter((name) => !name.startsWith(FTS_SHADOW_PREFIX))).toHaveLength(22);
      // The dump cannot carry them: `CREATE VIRTUAL TABLE` would refuse to create
      // a second copy. Only the trigger's own name (`messages_fts_after_delete`)
      // shares the prefix, so each shadow table's full name must be absent.
      for (const shadow of shadowTables) expect(schemaSql).not.toContain(shadow);

      // The three shapes batch 2 destroys. If any of these has already changed,
      // the "legacy" baseline is gone and every later assertion is meaningless.
      const columns = (table: string) => rows<{ name: string }>(db, `PRAGMA table_info("${table}")`).map((column) => column.name);
      expect(columns("folders")).toEqual(expect.arrayContaining(["total", "unseen"]));
      expect(columns("operation_queue")).toEqual(expect.arrayContaining(["kind", "payload_json", "status", "attempt_count", "completed_at"]));
      expect(tables).not.toContain("tasks");
    });
  });

  it("holds exactly the row inventory the README reports", () => {
    withFixture((db) => {
      const inventory: Record<string, number> = {};
      for (const { name } of rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
        if (name.startsWith(FTS_SHADOW_PREFIX)) continue;
        const count = countOf(db, `SELECT COUNT(*) AS count FROM "${name}"`);
        if (count) inventory[name] = count;
      }
      expect(inventory).toEqual({
        accounts: 2,
        batch_job_messages: 24,
        batch_jobs: 5,
        data_migrations: 5,
        folders: 12,
        messages: 15,
        messages_fts: 15,
        operation_queue: 6,
        outbound_attachment_submissions: 1,
        outbound_attachments: 1,
        outbound_submissions: 6,
        schema_meta: 1,
      });
      expect(Object.values(inventory).reduce((total, count) => total + count, 0)).toBe(93);
    });
  });

  it("opens every message with the fixture's key, and only with it", () => {
    withFixture((db) => {
      const messages = rows<MessageStorageRow>(db, "SELECT * FROM messages");
      expect(messages).toHaveLength(15);

      // The whole fixture is unusable if a payload cannot be read under the key
      // the README hands out, so this is the load-bearing half of the assertion.
      for (const message of messages) {
        expect(typeof messagePayloadForRow(message, MASTER_KEY).subject).toBe("string");
      }

      const encrypted = messages.filter((message) => typeof message.encrypted_payload === "string" && message.encrypted_payload.length > 0);
      expect(encrypted).toHaveLength(14);
      // An envelope that opens under any key is not an envelope: `payloadAad`
      // binds the row id and the account id, so the wrong key must fail on every
      // encrypted row rather than on a hand-picked one.
      for (const message of encrypted) {
        expect(() => messagePayloadForRow(message, WRONG_KEY)).toThrow();
      }

      // The pre-encryption row is the one that must NOT need a key: its reader is
      // `legacyPayload`, and it is also a row the FTS index was built through.
      const legacy = messages.find((message) => message.id === "fx-alpha-inbox-4")!;
      expect(legacy.encrypted_payload).toBeNull();
      expect(Number(legacy.payload_version)).toBe(0);
      expect((legacy as unknown as { payload_metadata_ready: string | null }).payload_metadata_ready).toBeNull();
      expect(typeof messagePayloadForRow(legacy, MASTER_KEY).subject).toBe("string");
    });
  });

  it("carries the queue states a migration has to transpose", () => {
    withFixture((db) => {
      const queue = rows<{ kind: string; status: string; attempt_count: number; completed_at: string | null }>(
        db,
        "SELECT kind, status, attempt_count, completed_at FROM operation_queue",
      );
      expect(queue).toHaveLength(6);

      // Exactly two rows are unfinished. They are the two `tasks` rows the
      // migration owes; the other four must produce nothing.
      expect(queue.filter((row) => row.status === "pending" || row.status === "running")).toHaveLength(2);

      // "running" is a claim, not a durable state: this is the row a crash
      // between the claim and the executor's return leaves behind, and no
      // migration may carry it across verbatim.
      const claimed = queue.filter((row) => row.status === "running");
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ kind: "flags-push", attempt_count: 1, completed_at: null });

      // Every `batch-move` row is terminal, and every settled row settles after
      // it was created — the ordering the create/settle timestamps must satisfy.
      expect(queue.filter((row) => row.kind === "batch-move" && row.status !== "completed")).toHaveLength(0);
      expect(queue.filter((row) => row.status === "failed")).toHaveLength(1);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM operation_queue WHERE status = 'failed' AND completed_at IS NULL")).toBe(0);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM operation_queue WHERE completed_at IS NOT NULL AND completed_at < created_at")).toBe(0);

      // The payload is where a queued row names its work; the two live rows have
      // to name the rows the README points at, or 7b and boundary 1 have lost
      // their claim source.
      const namedBy = (status: string) => {
        const row = rows<{ payload_json: string }>(db, "SELECT payload_json FROM operation_queue WHERE status = ?", status)[0]!;
        return (JSON.parse(row.payload_json) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id);
      };
      expect(namedBy("pending")).toEqual(["fx-alpha-inbox-2"]);
      expect(namedBy("running")).toEqual(["fx-alpha-sent-1"]);
    });
  });

  it("carries the job arithmetic, the deficit, and the two different `failed`s", () => {
    withFixture((db) => {
      expect(countOf(db, "SELECT COUNT(*) AS count FROM batch_jobs")).toBe(5);

      // Boundary 3. The three groups are derived from the selection's pre-state
      // rather than assumed: 2 changed, 1 refused, 5 already satisfied.
      const flagsJob = db.prepare("SELECT * FROM batch_jobs WHERE kind = 'flags'").get() as {
        id: string; status: string; total: number; updated: number; failed: number; undone: number;
      };
      expect(flagsJob).toMatchObject({ status: "completed", total: 8, updated: 2, failed: 1, undone: 1 });

      const flagsSelection = rows<{ message_id: string; changed: number; failed: number }>(
        db,
        "SELECT message_id, changed, failed FROM batch_job_messages WHERE job_id = ?",
        flagsJob.id,
      );
      expect(flagsSelection).toHaveLength(8);
      expect(flagsSelection.filter((row) => row.changed === 1).map((row) => row.message_id).sort())
        .toEqual(["fx-alpha-inbox-2", "fx-alpha-inbox-8"]);
      // The refusal is counted ONLY on the job. `acceptFlagsJob` inserts its
      // selection rows without the `failed` column, so they keep the DDL default
      // — which is why a migration cannot recover the refusal from the selection.
      expect(flagsSelection.filter((row) => row.failed !== 0)).toEqual([]);
      const refused = rows<{ state: string }>(db, `
        SELECT m.pending_move_state AS state FROM batch_job_messages b
        JOIN messages m ON m.id = b.message_id
        WHERE b.job_id = ? AND b.changed = 0 AND m.pending_move_state IS NOT NULL
      `, flagsJob.id);
      expect(refused).toEqual([{ state: "intent" }]);
      expect(flagsJob.total - flagsJob.updated - flagsJob.failed).toBe(5);

      // Boundaries 2 and 9: an undo job whose parent is marked undone, stored
      // `running` although every queue row it staged is already terminal.
      const undoJob = db.prepare("SELECT * FROM batch_jobs WHERE kind = 'undo'").get() as {
        parent_id: string | null; status: string; completed_at: number | null;
      };
      expect(undoJob.parent_id).toBe(flagsJob.id);
      expect(undoJob).toMatchObject({ status: "running", completed_at: null });

      // Boundaries 3, 8b and 10 on one job: acceptance-time numbers that are not
      // progress, 3 accounts of which one is gone, and the give-up latch.
      const moveJob = db.prepare("SELECT * FROM batch_jobs WHERE kind = 'move' ORDER BY total DESC LIMIT 1").get() as {
        id: string; total: number; updated: number; failed: number;
      };
      expect(moveJob).toMatchObject({ total: 11, updated: 0, failed: 1 });
      const moveSelection = rows<{ message_id: string; changed: number; failed: number }>(
        db,
        "SELECT message_id, changed, failed FROM batch_job_messages WHERE job_id = ?",
        moveJob.id,
      );
      expect(moveSelection).toHaveLength(11);
      expect(moveSelection.filter((row) => row.changed === 1)).toHaveLength(10);
      // The same name, a different quantity — deliberately unequal so no
      // migration can merge them without noticing.
      const giveUpLatch = moveSelection.filter((row) => row.failed === 1);
      expect(giveUpLatch.map((row) => row.message_id).sort()).toEqual(["fx-beta-inbox-1", "fx-beta-inbox-2"]);
      expect(giveUpLatch.length).not.toBe(moveJob.failed);
      // The refused id is `changed=0`, the same encoding the flags job uses for a
      // row it had nothing to do for: only the message's own state separates the
      // two.
      expect(moveSelection.filter((row) => row.changed === 0).map((row) => row.message_id)).toEqual(["fx-alpha-inbox-3"]);
      expect(db.prepare("SELECT pending_move_state AS state FROM messages WHERE id = ?").get("fx-alpha-inbox-3"))
        .toEqual({ state: "intent" });

      // Two of the eleven no longer resolve, because gamma's removal cascaded
      // its messages away; that is what makes this job only PARTLY attributable.
      expect(countOf(db, `
        SELECT COUNT(*) AS count FROM batch_job_messages b
        WHERE b.job_id = ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = b.message_id)
      `, moveJob.id)).toBe(2);
      expect(rows(db, `
        SELECT m.account_id AS account_id, COUNT(*) AS count FROM batch_job_messages b
        JOIN messages m ON m.id = b.message_id WHERE b.job_id = ? GROUP BY m.account_id ORDER BY m.account_id
      `, moveJob.id)).toEqual([{ account_id: "acc-alpha", count: 7 }, { account_id: "acc-beta", count: 2 }]);

      // Boundary 8b, and the distinction between the two orphan shapes: one job
      // has SOME unresolvable rows, the other has nothing but them.
      const orphans = rows<{ job_id: string; count: number }>(db, `
        SELECT b.job_id AS job_id, COUNT(*) AS count FROM batch_job_messages b
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = b.message_id) GROUP BY b.job_id
      `);
      expect(orphans.reduce((total, row) => total + row.count, 0)).toBe(3);
      const sizes = new Map(rows<{ job_id: string; count: number }>(
        db, "SELECT job_id, COUNT(*) AS count FROM batch_job_messages GROUP BY job_id",
      ).map((row) => [row.job_id, row.count]));
      const whollyOrphaned = orphans.filter((row) => sizes.get(row.job_id) === row.count);
      expect(whollyOrphaned).toHaveLength(1);
      expect(sizes.get(whollyOrphaned[0]!.job_id)).toBe(1);

      // Boundary 8a: a settled job whose selection is intact while the queue rows
      // that named it are already pruned. Attribution has to fall back to the
      // selection rows' messages, so the neighbouring job — whose rows were
      // pruned by predicate — is the control.
      const mentions = (jobId: string) => countOf(
        db,
        "SELECT COUNT(*) AS count FROM operation_queue WHERE kind = 'batch-move' AND payload_json LIKE ?",
        `%${jobId}%`,
      );
      const prunedJob = db.prepare("SELECT * FROM batch_jobs WHERE kind = 'move' AND total = 2").get() as { id: string };
      expect(mentions(prunedJob.id)).toBe(0);
      expect(mentions(moveJob.id)).toBe(2);
      expect(countOf(db, `
        SELECT COUNT(*) AS count FROM batch_job_messages b
        WHERE b.job_id = ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = b.message_id)
      `, prunedJob.id)).toBe(0);
    });
  });

  it("carries the counter drift batch 3 has to survive, and one impossible pair", () => {
    withFixture((db) => {
      // `folders.total` is maintained by hand in the legacy schema and is simply
      // wrong here. Batch 3 drops the column; this is the database that drop has
      // to come out of saying the same thing as the derived count.
      const drifted = rows<{ account_id: string; path: string; stored: number; held: number }>(db, `
        SELECT f.account_id AS account_id, f.path AS path, f.total AS stored,
          (SELECT COUNT(*) FROM messages m WHERE m.account_id = f.account_id AND m.effective_mailbox = f.path) AS held
        FROM folders f
        WHERE f.total <> (SELECT COUNT(*) FROM messages m WHERE m.account_id = f.account_id AND m.effective_mailbox = f.path)
        ORDER BY f.account_id, f.path
      `);
      expect(drifted.map((row) => `${row.account_id}/${row.path} ${row.stored}vs${row.held}`)).toEqual([
        "acc-alpha/Archive 2vs7",
        "acc-alpha/INBOX 6vs2",
        "acc-alpha/Sent 3vs1",
        "acc-beta/INBOX 0vs2",
        "acc-beta/Sent 3vs0",
        "acc-beta/Trash 1vs0",
      ]);

      // Unreachable by derivation, reachable in the legacy columns: the clamped
      // decrease plus the unclamped increase. The derived query must produce the
      // true count for this folder regardless.
      expect(rows(db, "SELECT account_id, path, total, unseen FROM folders WHERE unseen > total")).toEqual([
        { account_id: "acc-beta", path: "INBOX", total: 0, unseen: 1 },
      ]);
      expect(countOf(db, `
        SELECT COUNT(*) AS count FROM messages m
        WHERE m.account_id = 'acc-beta' AND m.effective_mailbox = 'INBOX'
      `)).toBe(2);
      expect(countOf(db, `
        SELECT COUNT(*) AS count FROM messages m
        WHERE m.account_id = 'acc-beta' AND m.effective_mailbox = 'INBOX'
          AND m.flags_json NOT LIKE '%\\Seen%'
      `)).toBe(1);
    });
  });

  it("carries the outbound ledger states, including the one that must not become work", () => {
    withFixture((db) => {
      expect(rows(db, "SELECT status, COUNT(*) AS count FROM outbound_submissions GROUP BY status ORDER BY status")).toEqual([
        { status: "confirmed", count: 1 },
        { status: "failed", count: 1 },
        { status: "pending", count: 3 },
        { status: "unknown_delivery", count: 1 },
      ]);
      // Every row carries a body: the request and the encryption envelope are not
      // optional, so a migration that copies the ledger has to take both.
      expect(countOf(db, "SELECT COUNT(*) AS count FROM outbound_submissions WHERE request_json IS NULL OR encrypted_details IS NULL")).toBe(0);

      // Boundary 4: exactly one row is scheduled. It is the only legacy ledger
      // row that yields a task with a real `due_at`; the other two `pending` rows
      // are immediate work, and `unknown_delivery` is neither.
      const scheduled = rows<{ status: string; send_at: string; created_at: string }>(
        db,
        "SELECT status, send_at, created_at FROM outbound_submissions WHERE send_at IS NOT NULL",
      );
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.status).toBe("pending");
      // Both are ISO-8601 UTC, so text ordering is chronological ordering — the
      // property the `due_at` conversion relies on.
      expect(scheduled[0]!.send_at > scheduled[0]!.created_at).toBe(true);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM outbound_submissions WHERE status = 'unknown_delivery' AND send_at IS NOT NULL")).toBe(0);

      // Boundary 6: the attachment survives the join.
      expect(countOf(db, "SELECT COUNT(*) AS count FROM outbound_attachment_submissions")).toBe(1);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM outbound_attachments")).toBe(1);
    });
  });

  it("keeps the migration bookkeeping a migration must read rather than re-apply", () => {
    withFixture((db) => {
      expect(rows<{ id: string }>(db, "SELECT id FROM data_migrations ORDER BY id").map((row) => row.id)).toEqual([
        "app_settings_intensity_check_0_100",
        "app_settings_sound_check_v2",
        "batch_jobs_move_kind",
        "message-fts-v2",
        "operation_queue_flags_push_kind",
      ]);
      expect(rows(db, "SELECT key, value FROM schema_meta")).toEqual([{ key: "schema_version", value: "1" }]);
    });
  });

  it("carries the local-first markers a flags commit and a move both have to respect", () => {
    withFixture((db) => {
      // 7a: a move whose response was lost. The generated `effective_mailbox`
      // keeps the message in its source folder, which is why a derivation that
      // trusted the destination column would already be wrong.
      expect(rows(db, `
        SELECT id, mailbox, effective_mailbox, pending_move_destination, pending_move_candidate_uid
        FROM messages WHERE pending_move_state = 'intent'
      `)).toEqual([{
        id: "fx-alpha-inbox-3",
        mailbox: "INBOX",
        effective_mailbox: "INBOX",
        pending_move_destination: "Archive",
        pending_move_candidate_uid: 9001,
      }]);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE pending_move_destination IS NOT NULL")).toBe(9);

      // 7b: three marker rows in three states, and the states are what make the
      // `COALESCE(pending_flags_push, 0)` predicate testable rather than merely
      // asserted.
      expect(rows(db, `
        SELECT id, pending_flags_base_json = flags_json AS settled FROM messages
        WHERE pending_flags_push = 1 ORDER BY id
      `)).toEqual([
        { id: "fx-alpha-inbox-2", settled: 0 },
        { id: "fx-alpha-inbox-8", settled: 1 },
        { id: "fx-alpha-sent-1", settled: 0 },
      ]);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE pending_flags_push IS NULL")).toBe(12);

      // The two unpushed markers are each named by a row that is still live; the
      // settled one is named only by rows that already finished, so re-pushing it
      // is exactly the mistake the third state exists to catch.
      const entriesOf = (predicate: string) => rows<{ payload_json: string }>(
        db, `SELECT payload_json FROM operation_queue WHERE kind = 'flags-push' AND ${predicate}`,
      ).flatMap((row) => (JSON.parse(row.payload_json) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id));
      const liveIds = entriesOf("status IN ('pending', 'running')");
      expect(liveIds.sort()).toEqual(["fx-alpha-inbox-2", "fx-alpha-sent-1"]);
      expect(entriesOf("status = 'completed'")).toContain("fx-alpha-inbox-8");
      expect(liveIds).not.toContain("fx-alpha-inbox-8");

      // The remaining deliberate shapes: a snoozed row, a row with attachments,
      // and the two rows an all-mail view has to deduplicate.
      expect(rows<{ id: string }>(db, "SELECT id FROM messages WHERE snoozed_until IS NOT NULL")).toEqual([{ id: "fx-alpha-inbox-6" }]);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE has_attachments = 1")).toBe(1);
      expect(rows<{ id: string }>(db, "SELECT id FROM messages WHERE all_mail_archived = 1 ORDER BY id").map((row) => row.id))
        .toEqual(["fx-alpha-archive-1", "fx-alpha-sent-1"]);
    });
  });
});
