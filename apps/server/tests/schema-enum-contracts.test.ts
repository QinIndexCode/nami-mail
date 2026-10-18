import { describe, expect, it } from "vitest";
import { autoReplyDecisionReasons, outboundSubmissionStatuses } from "@nami/agent-contracts";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { TASK_SCOPES, type TaskRow } from "../src/tasks/index.js";

/**
 * The two halves of the schema's enum story.
 *
 * Half one: an enum column whose CHECK constraint is a verbatim SQL string in
 * the schema (`db-schema.ts`; both the value set and the table's DDL moved
 * there). The wire vocabulary those gate lives in @nami/agent-contracts, and the
 * constraint's value set must equal the contract array's set exactly (membership,
 * not order — SQLite never reads it as an ordered list).
 *
 * Half two: `tasks`, where the constraint is deliberately ABSENT. Its `kind` and
 * `status` are the app's widest vocabularies and the ones most likely to grow
 * (batch 5 adds `filter`/`agent-apply`), and SQLite cannot widen a CHECK without
 * rebuilding the table — the one table everything writes through. So the single
 * source of truth moved into the TS unions in `tasks/types.ts`, compensated by
 * `recordTask`'s entry assertion and the `no_runner` fallback. That makes the
 * absence itself the thing to pin: "adding a constraint" always looks like an
 * improvement, so a CHECK appearing here would retire the reason for both
 * compensations with nothing failing to say so.
 */

/**
 * The value set of a `CHECK (column IN (…))` constraint, read from the table's
 * stored DDL.
 *
 * Callers anchor their regex on the literal `CHECK (column IN (` so a match can
 * never be reporting some other column's constraint, and bound the gap with
 * `[^;\n]*` so it cannot span lines either. The second half matters because
 * sqlite_master keeps a table's comments: with a plain `[^;]*` gap, a comment
 * above one column pairs with the real constraint below another.
 */
function checkValueSet(db: DatabaseHandle, table: string, constraint: RegExp): string[] {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`Table ${table} is missing from the schema.`);
  const match = row.sql.match(constraint);
  if (!match) throw new Error(`No CHECK (… IN (…)) constraint found for ${table}.`);
  return match[1]!
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (!value.startsWith("'") || !value.endsWith("'")) throw new Error(`Unexpected CHECK literal: ${value}`);
      return value.slice(1, -1);
    });
}

/**
 * `TaskRow`'s field names, spelled out because a type has no runtime presence.
 *
 * Three checks cover the three ways this list can be wrong, and none of them is
 * redundant: `satisfies` rejects a name that is not a `TaskRow` field, the
 * exhaustiveness probe below rejects a `TaskRow` field this list omits (the
 * direction `satisfies` cannot see), and `PRAGMA table_info` rejects a list the
 * actually-created table disagrees with.
 */
const TASK_ROW_FIELDS = [
  "id",
  "account_id",
  "kind",
  "scope",
  "parent_id",
  "status",
  "due_at",
  "next_attempt_at",
  "attempt_count",
  "max_attempts",
  "total",
  "updated",
  "failed",
  "payload_ciphertext",
  "payload_fingerprint",
  "payload_version",
  "idempotency_key",
  "undo_window_ms",
  "undone",
  "submission_id",
  "error_code",
  "error_message",
  "created_at",
  "updated_at",
  "completed_at",
] as const satisfies readonly (keyof TaskRow)[];

// Compile-time probe, same shape as the ones in `routes/error-codes.ts`: it
// evaluates to `true` only while the list above still covers `TaskRow`, so a
// field added to the type without a column assertion here fails `npm run
// typecheck` instead of shipping.
export type UncoveredTaskRowField = Exclude<keyof TaskRow, (typeof TASK_ROW_FIELDS)[number]>;
export const TASK_ROW_FIELDS_ARE_EXHAUSTIVE: UncoveredTaskRowField extends never ? true : never = true;

/**
 * The minimum an account row needs to exist, so `tasks.account_id`'s foreign key
 * has something to point at.
 */
function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `${id}@example.com`,
    "gmail",
    "Gmail",
    "encrypted",
    "imap.gmail.com",
    993,
    1,
    "smtp.gmail.com",
    465,
    1,
    "email",
    "connected",
    new Date().toISOString(),
  );
}

describe("schema enum CHECK constraints match the contract vocabulary", () => {
  it("outbound_submissions.status carries exactly the contract submission statuses", () => {
    const db = openDatabase(":memory:");
    try {
      expect(checkValueSet(db, "outbound_submissions", /status [^;\n]*?CHECK \(status IN \(([^)]*)\)\)/).sort())
        .toEqual([...outboundSubmissionStatuses].sort());
    } finally {
      db.close();
    }
  });

  it("auto_reply_decisions.reason carries exactly the contract decision reasons", () => {
    const db = openDatabase(":memory:");
    try {
      expect(checkValueSet(db, "auto_reply_decisions", /reason [^;\n]*?CHECK \(reason IN \(([^)]*)\)\)/).sort())
        .toEqual([...autoReplyDecisionReasons].sort());
    } finally {
      db.close();
    }
  });
});

describe("the tasks table's vocabulary lives in TS, not in the schema", () => {
  it("carries exactly TaskRow's fields, column for column", () => {
    const db = openDatabase(":memory:");
    try {
      const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name);
      // Sorted rather than in declaration order: `TaskRow`'s field order means
      // nothing (nothing reads it positionally), so asserting order would fail
      // on a harmless reordering of the type while catching no real drift.
      expect([...columns].sort()).toEqual([...TASK_ROW_FIELDS].sort());
    } finally {
      db.close();
    }
  });

  it("constrains scope to exactly TASK_SCOPES", () => {
    const db = openDatabase(":memory:");
    try {
      expect(checkValueSet(db, "tasks", /scope [^;\n]*?CHECK \(scope IN \(([^)]*)\)\)/).sort())
        .toEqual([...TASK_SCOPES].sort());
    } finally {
      db.close();
    }
  });

  it("accepts a kind and a status outside both vocabularies", () => {
    const db = openDatabase(":memory:");
    try {
      insertAccount(db);
      // Proven by insertion rather than by scanning the DDL text: sqlite_master
      // stores the CREATE statement with its comments intact, and the comment
      // explaining that `kind` has no CHECK sits two lines above the real `scope`
      // CHECK -- so `/kind[^;]*CHECK/` matches this DDL today and would report
      // the opposite of the truth. A row that an out-of-vocabulary kind/status
      // cannot be written for is the same statement as "no CHECK rejects it".
      db.prepare(
        "INSERT INTO tasks (id, account_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("task-outside-the-vocabulary", "account-1", "definitely-not-a-kind", "definitely-not-a-status", 1, 1);
      expect(db.prepare("SELECT kind, status FROM tasks WHERE id = ?").get("task-outside-the-vocabulary"))
        .toEqual({ kind: "definitely-not-a-kind", status: "definitely-not-a-status" });

      // The control that assertion needs: this database does reject a value the
      // one CHECK on the table covers, so the insert succeeding is evidence about
      // a constraint that is absent rather than about enforcement that never runs.
      expect(() =>
        db.prepare(
          "INSERT INTO tasks (id, account_id, kind, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("task-bad-scope", "account-1", "move", "definitely-not-a-scope", 1, 1),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
