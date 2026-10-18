import { describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { commitTask, openTaskPayload, taskRow } from "../src/tasks/index.js";
import { claimNextTask, dueAccountIds, pruneTerminalTasks, recordTask, settleTask, taskItems, taskProgress } from "../src/tasks/store.js";
import { PAYLOAD_ENVELOPE_VERSION, payloadFingerprint } from "../src/tasks/envelope.js";

/**
 * The task layer's own guarantees: the envelope, the atomic claim, the selection
 * materialization, and the retention rules that terminal statuses depend on.
 *
 * Internals (`store.ts`) are imported directly for the two things that are not
 * part of the public surface -- the claim predicate's sweep and terminal
 * cleanup. Testing either through the scheduler would mean a 24-hour clock and a
 * live chain; the layer's own contract is what is under test here.
 */

const MASTER_KEY = Buffer.alloc(32, 0x2b);
const WRONG_KEY = Buffer.alloc(32, 0x2c);

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

function withDb(run: (db: DatabaseHandle) => void): void {
  const db = openDatabase(":memory:");
  try {
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    run(db);
  } finally {
    db.close();
  }
}

function countTasks(db: DatabaseHandle, where = "1 = 1"): number {
  return db.prepare(`SELECT COUNT(*) FROM tasks WHERE ${where}`).pluck().get() as number;
}

/**
 * Every selection row, for the rollback test below.
 *
 * Deliberately not `taskItems(db, someId)`: that answers "no rows for this task id"
 * for a database with rows for any *other* id, so it cannot tell a rolled-back
 * materialization from one that ran outside the caller's transaction.
 */
function countTaskItems(db: DatabaseHandle): number {
  return db.prepare("SELECT COUNT(*) FROM task_items").pluck().get() as number;
}

const noopStarter = { start: () => undefined };

describe("task layer: the payload envelope", () => {
  it("stores a sealed payload whose plaintext is not recoverable from the row", () => {
    withDb((db) => {
      const id = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "move",
        payload: { target: "Archive", secret: "do-not-store-this-in-the-clear" },
      });
      const row = taskRow(db, id)!;
      expect(row.payload_version).toBe(PAYLOAD_ENVELOPE_VERSION);
      expect(row.payload_ciphertext).not.toContain("do-not-store-this-in-the-clear");
      expect(row.payload_ciphertext).not.toContain("Archive");
      expect(row.payload_fingerprint).toMatch(/^h1\./);
      expect(openTaskPayload(MASTER_KEY, row)).toEqual({ target: "Archive", secret: "do-not-store-this-in-the-clear" });
    });
  });

  it("honours a caller-chosen id, sealing under it rather than under a discarded one", () => {
    withDb((db) => {
      // The batch acceptances pick `${jobId}:${accountId}` so the compatibility
      // alias can group one job's tasks by id prefix (`migrate.ts:526-529` does the
      // same naming from the migration side). The seal's AAD is `{id, accountId}`
      // read off the row, so a row born under a UUID AAD and then renamed would not
      // open -- which is what lets this assertion tell "the id was in place before
      // the seal" from "it was patched on afterwards".
      const id = recordTask(db, MASTER_KEY, {
        id: "job-1:account-1",
        accountId: "account-1",
        kind: "move",
        payload: { target: "Archive" },
      });
      expect(id).toBe("job-1:account-1");
      const row = taskRow(db, "job-1:account-1")!;
      expect(row.id).toBe("job-1:account-1");
      expect(openTaskPayload(MASTER_KEY, row)).toEqual({ target: "Archive" });
    });
  });

  it("fails to open a payload under a different master key instead of returning something", () => {
    withDb((db) => {
      const id = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { target: "Archive" } });
      expect(() => openTaskPayload(WRONG_KEY, taskRow(db, id)!)).toThrow();
    });
  });

  it("records a task with no payload as NULL ciphertext, not as a sealed empty object", () => {
    withDb((db) => {
      // kind='send' takes this path: its payload is the delivery ledger's own
      // sealed request, and a copy here would be a second ciphertext to drift.
      const id = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "send" });
      const row = taskRow(db, id)!;
      expect(row.payload_ciphertext).toBeNull();
      expect(row.payload_fingerprint).toBeNull();
      expect(openTaskPayload(MASTER_KEY, row)).toBeUndefined();
    });
  });

  it("fingerprints the same value the same way regardless of key order", () => {
    expect(payloadFingerprint(MASTER_KEY, "account-1", { b: 1, a: 2 }))
      .toBe(payloadFingerprint(MASTER_KEY, "account-1", { a: 2, b: 1 }));
    expect(payloadFingerprint(MASTER_KEY, "account-1", { a: 1 }))
      .not.toBe(payloadFingerprint(MASTER_KEY, "account-1", { a: 2 }));
  });
});

describe("task layer: durable rows", () => {
  it("refuses a kind outside the vocabulary before writing anything", () => {
    withDb((db) => {
      expect(() => recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "teleport" as never })).toThrow(/Unknown task kind/);
      expect(countTasks(db)).toBe(0);
    });
  });

  it("materializes a selection, keeping one row per message", () => {
    withDb((db) => {
      const id = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "move",
        scope: "batch",
        items: [
          { messageId: "m1", changed: true, originMailbox: "INBOX", destinationMailbox: "Archive" },
          { messageId: "m2" },
          { messageId: "m1", changed: false },
        ],
      });
      const items = taskItems(db, id);
      expect(items.map((item) => item.message_id)).toEqual(["m1", "m2"]);
      expect(items[0]).toMatchObject({ changed: 1, origin_mailbox: "INBOX", destination_mailbox: "Archive" });
      expect(items[1]).toMatchObject({ changed: 0, origin_mailbox: null, destination_mailbox: null });
    });
  });

  it("leaves nothing behind when the transaction around commitTask rolls back", () => {
    withDb((db) => {
      const start = vi.fn();
      expect(() => db.transaction(() => {
        commitTask({ db, masterKey: MASTER_KEY, scheduler: { start } }, {
          accountId: "account-1",
          kind: "move",
          scope: "batch",
          items: [
            { messageId: "m1", changed: true, originMailbox: "INBOX", destinationMailbox: "Archive" },
            { messageId: "m2" },
          ],
        });
        throw new Error("boom");
      })()).toThrow("boom");
      // The whole point of commitTask: the task row and the local state it
      // describes are one commit, so a rollback discards both. The selection is
      // where that is testable -- a task row with no items would take the same
      // rollback for granted -- and the count is whole-table, so a materialization
      // that ran *outside* the caller's transaction cannot hide behind an id no
      // assertion looks at.
      expect(countTasks(db)).toBe(0);
      expect(countTaskItems(db)).toBe(0);
      // start() was never called, and would have been a no-op anyway -- the
      // scheduler claims by predicate, so an erased row is simply not there.
      expect(start).not.toHaveBeenCalled();
    });
  });

  it("stamps a committed task with the defaults the scheduler reads", () => {
    withDb((db) => {
      const handle = commitTask({ db, masterKey: MASTER_KEY, scheduler: noopStarter }, { accountId: "account-1", kind: "flags" });
      const row = taskRow(db, handle.id)!;
      expect(row).toMatchObject({
        status: "pending",
        scope: "single",
        attempt_count: 0,
        max_attempts: 8,
        total: 0,
        updated: 0,
        failed: 0,
        next_attempt_at: null,
        due_at: null,
        undone: 0,
        parent_id: null,
      });
      expect(handle.kind).toBe("flags");
    });
  });

  it("derives total from the selection and lets a caller override it", () => {
    withDb((db) => {
      const fromItems = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "move",
        scope: "batch",
        items: [{ messageId: "m1" }, { messageId: "m2" }],
      });
      expect(taskRow(db, fromItems)!.total).toBe(2);
      // A flags job counts messages it actually applied, which is not the
      // selection size, so the caller states its own ceiling.
      const explicit = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "flags", scope: "batch", total: 7 });
      expect(taskRow(db, explicit)!.total).toBe(7);
    });
  });
});

describe("task layer: the claim", () => {
  it("takes the oldest claimable row first, and only once", () => {
    withDb((db) => {
      const first = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 1_000 });
      const second = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 2_000 });
      const third = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 3_000 });
      const claimed = [
        claimNextTask(db, "account-1")?.id,
        claimNextTask(db, "account-1")?.id,
        claimNextTask(db, "account-1")?.id,
        claimNextTask(db, "account-1")?.id,
      ];
      expect(claimed).toEqual([first, second, third, undefined]);
      expect(taskRow(db, first)!.attempt_count).toBe(1);
      expect(taskRow(db, first)!.status).toBe("running");
    });
  });

  it("skips a row whose due_at has not arrived, then takes it once it has", () => {
    withDb((db) => {
      const later = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "send", dueAt: 10_000, now: 1_000 });
      const now = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 2_000 });
      expect(claimNextTask(db, "account-1", 5_000)?.id).toBe(now);
      expect(claimNextTask(db, "account-1", 5_000)).toBeNull();
      expect(claimNextTask(db, "account-1", 10_000)?.id).toBe(later);
    });
  });

  it("skips a row waiting out its backoff", () => {
    withDb((db) => {
      const id = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 1_000 });
      expect(claimNextTask(db, "account-1", 1_000)?.id).toBe(id);
      db.prepare("UPDATE tasks SET status = 'pending', next_attempt_at = ? WHERE id = ?").run(9_000, id);
      expect(claimNextTask(db, "account-1", 8_000)).toBeNull();
      expect(claimNextTask(db, "account-1", 9_000)?.id).toBe(id);
    });
  });

  it("keeps one account's queue out of another's", () => {
    withDb((db) => {
      const mine = recordTask(db, MASTER_KEY, { accountId: "account-2", kind: "move", now: 1_000 });
      recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 1_000 });
      expect(claimNextTask(db, "account-2")?.id).toBe(mine);
      expect(claimNextTask(db, "account-2")).toBeNull();
      expect(claimNextTask(db, "account-1")?.id).not.toBe(mine);
    });
  });

  it("lists exactly the accounts with claimable work", () => {
    withDb((db) => {
      recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 1_000 });
      recordTask(db, MASTER_KEY, { accountId: "account-2", kind: "send", dueAt: 50_000, now: 1_000 });
      expect(dueAccountIds(db, 2_000)).toEqual(["account-1"]);
      expect(dueAccountIds(db, 60_000).sort()).toEqual(["account-1", "account-2"]);
    });
  });
});

describe("task layer: progress projection", () => {
  it("reports counts, terminal error, undo deadline and parent", () => {
    withDb((db) => {
      const parent = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", scope: "batch" });
      const child = recordTask(db, MASTER_KEY, {
        accountId: "account-1",
        kind: "undo",
        scope: "batch",
        parentId: parent,
        total: 4,
        undoWindowMs: 300_000,
        now: 1_000,
      });
      settleTask(db, child, "failed", { code: "provider_rejected", message: "nope" }, 2_000);
      expect(taskProgress(db, child)).toEqual({
        id: child,
        kind: "undo",
        scope: "batch",
        status: "failed",
        total: 4,
        updated: 0,
        failed: 0,
        error: { code: "provider_rejected", message: "nope" },
        // Measured from the settlement (2_000), not from the record (1_000): the
        // window is the user's time to change their mind about work that has
        // *finished*, and the legacy measured it the same way (§4.7 A ③). The two
        // numbers differ here on purpose -- the task was recorded a second before it
        // ended -- so this assertion can tell the two bases apart.
        undoDeadline: 302_000,
        parentId: parent,
      });
      expect(taskProgress(db, "missing")).toBeNull();
    });
  });
});

describe("task layer: retention", () => {
  const now = 10 * 24 * 60 * 60 * 1000;

  it("prunes every terminal status, including the two the legacy prune forgot", () => {
    withDb((db) => {
      // `cancelled` and `unknown_delivery` are new here. The legacy cleanup
      // listed only completed/failed, so a status left out of this sweep would
      // keep its rows forever -- which is why the sweep, not the vocabulary, is
      // what this test pins.
      for (const status of ["completed", "failed", "cancelled", "unknown_delivery"] as const) {
        const id = recordTask(db, MASTER_KEY, {
          accountId: "account-1",
          kind: "move",
          items: [{ messageId: "m1" }],
          now: now - 25 * 60 * 60 * 1000,
        });
        settleTask(db, id, status, null, now - 25 * 60 * 60 * 1000);
      }
      expect(countTasks(db)).toBe(4);
      expect(pruneTerminalTasks(db, now)).toBe(4);
      expect(countTasks(db)).toBe(0);
      // task_items go with their task through the FK cascade, so the sweep
      // cannot leave selection rows pointing at a task that no longer exists.
      expect(db.prepare("SELECT COUNT(*) FROM task_items").pluck().get()).toBe(0);
    });
  });

  it("spares non-terminal rows and terminal rows still inside the TTL", () => {
    withDb((db) => {
      const older = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 1_000 });
      const newer = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 2_000 });
      const claimed = claimNextTask(db, "account-1");
      // The claim takes the oldest row, so the outcome of the sweep can be
      // asserted per row: the claimed one is non-terminal in a second way.
      expect(claimed?.id).toBe(older);
      const recent = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "move", now: 3_000 });
      settleTask(db, recent, "completed", null, now - 60_000);
      expect(pruneTerminalTasks(db, now)).toBe(0);
      expect(countTasks(db)).toBe(3);
      expect(taskRow(db, older)!.status).toBe("running");
      expect(taskRow(db, newer)!.status).toBe("pending");
      expect(taskRow(db, recent)!.status).toBe("completed");
    });
  });

  it("keeps a terminal row whose undo window is still open", () => {
    withDb((db) => {
      // The row is past the retention TTL and only the undo offer keeps it
      // alive. That window (25h) is longer than the TTL (24h) on purpose: a
      // shorter one could never be observed here, and this is exactly the
      // retuning of the TTL at which an unnoticed deletion would take away a
      // live undo offer.
      const window = 25 * 60 * 60 * 1000;
      const created = now - window + 60_000;
      const id = recordTask(db, MASTER_KEY, { accountId: "account-1", kind: "undo", undoWindowMs: window, now: created });
      settleTask(db, id, "completed", null, created);
      expect(taskProgress(db, id)!.undoDeadline).toBe(created + window);
      expect(pruneTerminalTasks(db, now)).toBe(0);
      expect(countTasks(db)).toBe(1);
      // Once the offer closes the row is ordinary garbage.
      expect(pruneTerminalTasks(db, created + window + 1)).toBe(1);
      expect(countTasks(db)).toBe(0);
    });
  });
});
