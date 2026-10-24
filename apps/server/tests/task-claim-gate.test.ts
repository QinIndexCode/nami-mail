import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { claimNextTask, recordTask, taskRow } from "../src/tasks/index.js";

/**
 * §8 G13: claiming a task is atomic.
 *
 * Two halves, because neither alone is enough.
 *
 * **Behaviorally**, one pending task claimed twice yields exactly one row and
 * one refusal -- and the refusal must leave no trace, which is what
 * `attempt_count` is read back for. A claim that incremented the counter before
 * checking whether the row was still pending would show 2 here, even though the
 * "one winner" assertion would still pass.
 *
 * **Structurally**, the behaviour cannot be distinguished from a
 * `SELECT`-then-`UPDATE` pair in a single-threaded runtime: a sequential second
 * call sees `running` either way. The race the design guards against is a
 * due-time tick and an immediate `start()` claiming the same row in the same
 * beat, which one process's test cannot schedule. So the statement's shape is
 * asserted from the source: one `UPDATE` carrying its own subquery, its own
 * `AND status = 'pending'` re-test, and the `created_at, rowid` ordering that
 * makes two writes to one message apply in commit order rather than in
 * UUID-draw order.
 *
 * A regex over source text is the tool the repo already uses for this class of
 * claim (`provider-boundary.test.ts`), and it is honest about what it proves:
 * it proves the shape, not the atomicity. The atomicity is the shape's
 * consequence, and the shape is what a careless edit destroys.
 */

const STORE_PATH = fileURLToPath(new URL("../src/tasks/store.ts", import.meta.url));

/** The body of `claimNextTask`, from its declaration to the next top-level export. */
function claimNextTaskSource(): string {
  const source = fs.readFileSync(STORE_PATH, "utf8");
  const start = source.indexOf("export function claimNextTask");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nexport function ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  expect(body.length).toBeGreaterThan(0);
  return body;
}

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `${id}@example.com`, "gmail", "Gmail", "encrypted", "imap.gmail.com", 993, 1, "smtp.gmail.com", 465, 1, "email", "connected", new Date().toISOString());
}

describe("task claim (G13): one winner, and the shape that keeps it that way", () => {
  it("hands one pending task to exactly one claimer, writing nothing on the refusal", () => {
    const db = openDatabase(":memory:");
    try {
      insertAccount(db);
      const id = recordTask(db, Buffer.alloc(32, 3), { accountId: "account-1", kind: "move" });

      const winner = claimNextTask(db, "account-1", 1_000);
      expect(winner?.id).toBe(id);
      expect(winner?.status).toBe("running");
      expect(winner?.attempt_count).toBe(1);

      // The loser's UPDATE matches nothing, so it neither returns a row nor
      // moves the counter. Both halves matter: a "claim" that returned null but
      // had already spent an attempt would shorten the retry budget silently.
      expect(claimNextTask(db, "account-1", 1_001)).toBeNull();
      expect(taskRow(db, id)).toMatchObject({ status: "running", attempt_count: 1 });

      // A finished row is not claimable again, whatever its counters say.
      db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(2_000, id);
      expect(claimNextTask(db, "account-1", 2_001)).toBeNull();
      expect(taskRow(db, id)?.attempt_count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("claims with one self-guarded statement, not a read followed by a write", () => {
    const body = claimNextTaskSource();
    // One `prepare` call: a SELECT-then-UPDATE implementation has two, and the
    // gap between them is the race.
    expect(body.match(/db\.prepare\(/g)).toHaveLength(1);

    const statement = body.match(/`([\s\S]*?)`/)?.[1];
    expect(statement).toBeTruthy();
    expect(statement).toContain("UPDATE tasks");
    expect(statement).toContain("AND status = 'pending'");
    expect(statement).toMatch(/\(SELECT id FROM tasks[\s\S]*?LIMIT 1\)/);
    expect(statement).toContain("RETURNING");
    // The tie-break is the insertion sequence, not the UUID: two tasks committed
    // in the same millisecond are the normal case (a batch move and its undo).
    expect(statement).toContain("ORDER BY created_at, rowid");
    // One statement, so `prepare` accepts it at all -- the list is a list rather
    // than a split blob for this reason.
    expect(statement).not.toContain(";");
  });

  it("keeps every claim site inside the layer rather than exporting the statement", () => {
    // `claimNextTask` and `claimTaskRow` are the only two claimers, and only the
    // first is public. A caller that could claim by hand would be a second place
    // for the predicate to drift.
    const source = fs.readFileSync(STORE_PATH, "utf8");
    expect(source.match(/SET status = 'running'/g)).toHaveLength(2);
    const publicSurface = fs.readFileSync(fileURLToPath(new URL("../src/tasks/index.ts", import.meta.url)), "utf8");
    // Comments stripped before matching: `index.ts`'s doc block names
    // `claimTaskRow` precisely to say it is *not* exported, and a comment is not
    // an import clause -- the same discipline §8 G15 spells out for the
    // `operation-queue` ban.
    const exportSurface = publicSurface
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(exportSurface).toContain("claimNextTask");
    expect(exportSurface).not.toContain("claimTaskRow");
  });
});
