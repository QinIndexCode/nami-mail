import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { recordTask } from "../src/tasks/store.js";
import { settleTask } from "../src/tasks/store.js";
import { clearConfirmedFlagsMarkers, clearOrphanedFlagsMarkers, flagsProtectedMessageIds, mailboxesStagedBy } from "../src/tasks/settlement.js";

/**
 * The settlement surface: the two questions a settling push task asks, and the
 * mailbox map the failure rollback needs.
 *
 * The fixture is the real schema through the real open path, because the whole
 * point of these functions is what they read -- `tasks`, `task_items` and
 * `messages.pending_flags_push`. A hand-built stand-in would let the queries
 * drift from the columns they name without failing.
 *
 * The tests are written against the *reason* each clause exists rather than
 * against the current result:
 *
 *   - the strongest one is the live task with a payload that names no entries.
 *     The legacy implementation answered "is another push holding this id" by
 *     scanning live payloads with `json_each`, so that task protected nothing;
 *     the structural reading protects it, and the test pins that difference.
 *   - status is load-bearing in both directions: a live task protects, a terminal
 *     one must not (or a message's marker would never clear and its flags would
 *     stop following the server).
 */

const MASTER_KEY = Buffer.alloc(32, 0x2b);

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `${id}@example.com`, "gmail", "Gmail", "encrypted", "imap.gmail.com", 993, 1, "smtp.gmail.com", 465, 1, "email", "connected", "2026-10-17T00:00:00.000Z");
}

/**
 * A message row carrying the push marker. Only the columns the queries touch.
 *
 * `uid` is drawn from a counter rather than fixed: `messages` carries
 * `UNIQUE (account_id, mailbox, uid)` (`db-schema.ts:129`), so a constant would
 * make the second row in a mailbox fail on the constraint instead of in the
 * assertion the test is about.
 */
let nextUid = 1;
function insertMessage(db: DatabaseHandle, id: string, accountId = "account-1", mailbox = "INBOX", pending = true): void {
  db.prepare(`
    INSERT INTO messages (id, account_id, mailbox, uid, created_at, pending_flags_push)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, accountId, mailbox, nextUid++, "2026-10-17T00:00:00.000Z", pending ? 1 : 0);
}

function withDb(run: (db: DatabaseHandle) => void): void {
  const db = openDatabase(":memory:");
  try {
    insertAccount(db, "account-1");
    run(db);
  } finally {
    db.close();
  }
}

const markerOf = (db: DatabaseHandle, id: string): number =>
  db.prepare("SELECT pending_flags_push FROM messages WHERE id = ?").pluck().get(id) as number;

describe("task settlement: which messages a live push still holds", () => {
  it("protects the ids its selection names even when its payload names none", () => {
    withDb((db) => {
      // The unification (contract §4.7 B) makes `flags` one kind with one payload
      // shape, but a *migrated* row keeps the queue's own payload verbatim, and
      // `planQueueTask` accepts a singular `{messageId, patch}` as well as
      // `{ids, patch}` (migrate.ts:289-292, and `flagMessageIds` at `:183-200`).
      // Neither carries `entries`, so a
      // payload-based reading would see a live push holding nothing and clear the
      // marker out from under it.
      const live = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "flags",
        payload: { messageId: "m1", patch: { seen: true } },
        items: [{ messageId: "m1" }],
      });
      recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "flags",
        payload: {},
        items: [{ messageId: "m2" }],
      });

      expect([...flagsProtectedMessageIds(db)].sort()).toEqual(["m1", "m2"]);
      expect(flagsProtectedMessageIds(db, live).has("m1")).toBe(false);
      expect(flagsProtectedMessageIds(db, live).has("m2")).toBe(true);
    });
  });

  it("stops protecting once the task reaches any terminal status", () => {
    withDb((db) => {
      const statuses = ["completed", "failed", "cancelled", "unknown_delivery"] as const;
      const ids = statuses.map((status, index) => {
        const id = recordTask(db, MASTER_KEY, {
          accountId: "account-1",
          kind: "flags",
          items: [{ messageId: `m-${status}` }],
        });
        settleTask(db, id, status, null);
        return { status, id, index };
      });
      expect(ids).toHaveLength(4);
      // All four, not just the two the legacy prune covered: `cancelled` and
      // `unknown_delivery` are new vocabulary, and a status left out of this
      // reading would hold its markers for good.
      expect(flagsProtectedMessageIds(db).size).toBe(0);
    });
  });

  it("protects nothing for a live task of another kind", () => {
    withDb((db) => {
      recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "move",
        payload: { target: "Archive" },
        items: [{ messageId: "m1" }],
      });
      // A move in flight does not hold a push marker: the *push* task does. If
      // this protected `m1`, a message whose move is retrying would keep a stale
      // flag target for the life of the move.
      expect(flagsProtectedMessageIds(db).size).toBe(0);
    });
  });
});

describe("task settlement: clearing the push markers", () => {
  it("clears what no live push holds, and nothing else", () => {
    withDb((db) => {
      insertMessage(db, "m1");
      insertMessage(db, "m2");
      insertMessage(db, "m3", "account-1", "INBOX", false);
      const settled = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "flags",
        items: [{ messageId: "m1" }],
      });
      recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "flags",
        items: [{ messageId: "m2" }],
      });

      clearConfirmedFlagsMarkers(db, ["m1", "m2", "m3"], settled);

      expect(markerOf(db, "m1")).toBe(0);
      expect(markerOf(db, "m2")).toBe(1); // a newer push still holds it
      expect(markerOf(db, "m3")).toBe(0);

      // Idempotent, and a duplicate id in the input is not an error -- a settled
      // push's entries can legitimately name the same message twice.
      clearConfirmedFlagsMarkers(db, ["m1", "m1", "m2"], settled);
      expect(markerOf(db, "m1")).toBe(0);
      expect(markerOf(db, "m2")).toBe(1);
    });
  });

  it("clears its own markers when the settling task is the only holder", () => {
    withDb((db) => {
      insertMessage(db, "m1");
      const own = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "flags",
        items: [{ messageId: "m1" }],
      });

      // Without the exclusion the task would protect the very marker it is
      // settling, and the marker would never clear while its task was live.
      clearConfirmedFlagsMarkers(db, ["m1"], own);
      expect(markerOf(db, "m1")).toBe(0);
    });
  });

  it("reconciles markers with no push behind them at startup, and reports the count", () => {
    withDb((db) => {
      insertMessage(db, "m1");
      insertMessage(db, "m2");
      recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "flags",
        items: [{ messageId: "m2" }],
      });

      // m1's marker is the crash artifact this pass exists for: a build that
      // committed the marker and lost the push task. m2's is behind a live push
      // and must survive.
      expect(clearOrphanedFlagsMarkers(db)).toBe(1);
      expect(markerOf(db, "m1")).toBe(0);
      expect(markerOf(db, "m2")).toBe(1);
      // Nothing left to repair, so the pass says so rather than reporting work.
      expect(clearOrphanedFlagsMarkers(db)).toBe(0);
    });
  });
});

describe("task settlement: the mailbox a commit landed in", () => {
  it("reads the staged positions out of the payload it is handed", () => {
    // The legacy reading re-fetched `payload_json` by row id; after
    // `sealMigratedTaskPayloads` that is an envelope, so the hook has to use the
    // payload it was handed. This is that function, with no database at all.
    const mailboxes = mailboxesStagedBy({
      accountId: "account-1",
      entries: [
        { id: "m1", mailbox: "Archive", uid: 7, add: ["\\Seen"], remove: [] },
        { id: "m2", mailbox: "INBOX", uid: 9, add: [], remove: ["\\Flagged"] },
      ],
    });
    expect([...mailboxes]).toEqual([["m1", "Archive"], ["m2", "INBOX"]]);
  });

  it("returns a partial map rather than inventing a position", () => {
    // The call site falls back to `messages.mailbox` for an id the map does not
    // name, which is the legacy behavior for a direct caller or a row whose
    // payload is the older singular spelling. Covering those with a made-up
    // mailbox would move a folder's unread count to a folder the commit never
    // touched -- worse than the fallback.
    expect(mailboxesStagedBy({ messageId: "m1", patch: { seen: true } }).size).toBe(0);
    expect(mailboxesStagedBy({ ids: ["m1", "m2"], patch: {} }).size).toBe(0);
    expect(mailboxesStagedBy(null).size).toBe(0);
    expect(mailboxesStagedBy("not-a-payload").size).toBe(0);
    expect(
      mailboxesStagedBy({ entries: [null, { id: "m1" }, { mailbox: "INBOX" }, { id: "m2", mailbox: "Archive" }] }),
    ).toEqual(new Map([["m2", "Archive"]]));
  });
});

const SETTLEMENT_PATH = fileURLToPath(new URL("../src/tasks/settlement.ts", import.meta.url));

/** Source with block and line comments removed. §8 G15: a comment mentioning a
 * thing is not doing it, so nothing here may be satisfied by prose. */
function strippedSource(): string {
  const source = fs.readFileSync(SETTLEMENT_PATH, "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The body of one exported function, to the next top-level export or EOF. */
function functionSource(name: string): string {
  const source = fs.readFileSync(SETTLEMENT_PATH, "utf8");
  const start = source.indexOf(`export function ${name}`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

/**
 * The module's central claim, asserted from the source rather than from a run.
 *
 * The tests above prove behaviour; what they cannot see is a future edit that
 * reinstates the legacy reading for speed. That edit would look correct against
 * every payload these tests build, because a payload-based reading and a
 * selection-based one agree whenever the payload names the ids -- which is true
 * of every shape except the one the first test exists for. So the shape is
 * pinned directly, which is the §8 G13 precedent: a regex proves the shape, not
 * the behavior, and the shape is what a careless edit destroys.
 */
describe("task settlement: the reading is structural, not payload-based", () => {
  it("never validates or walks a payload in SQL", () => {
    const source = strippedSource();
    // Positive control first: a strip that removed too much (or a path that read
    // nothing) would make the negative below pass for the wrong reason, which is
    // the "assertion that can pass by being empty" trap the migration tests were
    // repaired for.
    expect(source).toMatch(/task_items/);
    expect(source.length).toBeGreaterThan(1_000);
    // The legacy query needed `json_valid` and `json_each` (the deleted
    // `flagsPushProtectedMessageIds`; `tasks/settlement.ts:11-12` records what it
    // did), plus a MATERIALIZED CTE so the planner could not reorder the guard away
    // from the function that depended on it. A join needs none of that, and the
    // moment one of these reappears the CTE's absence becomes a live bug.
    expect(source).not.toMatch(/json_each|json_valid/);
  });

  it("asks which messages a live push holds with one join, and names only task tables", () => {
    const flags = functionSource("flagsProtectedMessageIds");
    expect(flags.match(/db\s*\.prepare\(/g) ?? []).toHaveLength(1);
    expect(flags).toMatch(/FROM\s+task_items\s+AS\s+item/i);
    expect(flags).toMatch(/JOIN\s+tasks\s+AS\s+task/i);
    expect(flags).toMatch(/status\s+IN\s*\('pending',\s*'running'\)/i);
    expect(flags).toMatch(/task\.kind\s*=\s*'flags'/i);
    // The exclusion is what lets a settled push clear the markers it staged.
    expect(flags).toMatch(/task\.id\s*!=\s*\?/i);
    // Every table this module reads must exist after the legacy DROP. A
    // reference to any of the three dropped stores would compile, pass lint, and
    // fail only at the first settlement on a migrated database.
    expect(strippedSource()).not.toMatch(/operation_queue|batch_jobs|batch_job_messages/);
  });
});
