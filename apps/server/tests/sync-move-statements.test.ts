import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  createMoveStatements,
  moveStatements,
  type MoveStatements,
} from "../src/sync-move-statements.js";

/**
 * The move paths compile their SQL once per connection and replay the
 * statements for every message. That is only sound if a better-sqlite3
 * Statement carries nothing between calls and nothing across a transaction
 * boundary, so these are the driver's properties the whole optimization rests
 * on. They are asserted here against the real driver rather than assumed.
 */
describe("move statement reuse", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES ('account-1', 'demo@example.com', 'custom', 'Demo', 'encrypted',
        'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
    `).run(now);
    db.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("replays one compiled statement across committed and rolled-back transactions", () => {
    const insert = db.prepare("INSERT INTO rows (v) VALUES (?)");
    const read = db.prepare("SELECT v FROM rows ORDER BY id");

    expect(() => db.transaction(() => {
      insert.run("rolled-back");
      throw new Error("rollback");
    })()).toThrow("rollback");
    // A rollback must leave the statement usable, not poisoned: the next move
    // on this connection reuses the very same object.
    db.transaction(() => { insert.run("kept"); })();
    expect(read.all()).toEqual([{ v: "kept" }]);

    // Bindings are per call, so nothing from the rolled-back run leaks into
    // the next one, and `changes` reports that run alone.
    expect(insert.run("second").changes).toBe(1);
    expect(read.all()).toEqual([{ v: "kept" }, { v: "second" }]);
  });

  it("sees its own transaction's uncommitted writes and never a stale snapshot", () => {
    const insert = db.prepare("INSERT INTO rows (v) VALUES (?)");
    const read = db.prepare("SELECT v FROM rows ORDER BY id");

    expect(read.all()).toEqual([]);
    db.transaction(() => {
      insert.run("inside");
      // The read runs inside the same transaction, after a write: hoisting
      // these statements out of the transaction must not change what they see.
      expect(read.all()).toEqual([{ v: "inside" }]);
    })();
    expect(read.all()).toEqual([{ v: "inside" }]);
  });

  it("keeps a statement working after the schema changes underneath it", () => {
    const insert = db.prepare("INSERT INTO rows (v) VALUES (?)");
    const read = db.prepare("SELECT v FROM rows ORDER BY id");
    insert.run("before");

    db.exec("ALTER TABLE rows ADD COLUMN extra TEXT NOT NULL DEFAULT 'dflt'");

    // SQLite re-prepares a statement whose schema changed underneath it, so a
    // long-lived bundle survives a migration instead of failing the next move.
    expect(read.all()).toEqual([{ v: "before" }]);
    expect(insert.run("after").changes).toBe(1);
    expect(db.prepare("SELECT extra FROM rows").all()).toEqual([{ extra: "dflt" }, { extra: "dflt" }]);
  });

  it("replays the real move statements after a rolled-back message transaction", () => {
    // The batch path runs one transaction per message and keeps going when one
    // of them throws, so a rollback is the *normal* case a reused statement has
    // to survive: the next message runs the very same objects. If a rolled-back
    // transaction left a compiled statement holding bindings, a partially
    // applied write, or a stale `changes`, the next message would write to the
    // previous message's row.
    const statements = createMoveStatements(db);
    for (const [index, id] of ["first", "second"].entries()) {
      db.prepare(`
        INSERT INTO messages (id, account_id, mailbox, uid, subject, from_name, from_address, to_json, sent_at, created_at)
        VALUES (?, 'account-1', 'INBOX', ?, 's', 'd', 'd@e', '[]', '2026-01-01', '2026-01-01')
      `).run(id, 5 + index);
    }

    expect(() => db.transaction(() => {
      expect(statements.beginMoveIntent.run("Trash", null, "\\Trash", "first").changes).toBe(1);
      expect(statements.uidPlusConfirm.run("Trash", 9, null, "first").changes).toBe(1);
      throw new Error("this message failed after the statements ran");
    })()).toThrow("this message failed after the statements ran");

    // The rollback undid the first message's writes...
    expect(db.prepare("SELECT mailbox, uid, pending_move_state FROM messages WHERE id = 'first'").get())
      .toEqual({ mailbox: "INBOX", uid: 5, pending_move_state: null });
    // ...and the same statements still drive the next message correctly.
    db.transaction(() => {
      expect(statements.beginMoveIntent.run("Trash", null, "\\Trash", "second").changes).toBe(1);
      expect(statements.uidPlusConfirm.run("Trash", 9, null, "second").changes).toBe(1);
    })();
    expect(db.prepare("SELECT mailbox, uid, pending_move_state FROM messages WHERE id = 'second'").get())
      .toEqual({ mailbox: "Trash", uid: 9, pending_move_state: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox = 'Trash'").get())
      .toEqual({ count: 1 });
  });

  it("keeps one bundle per connection and never hands a statement to another", () => {
    const other = openDatabase(":memory:");
    try {
      expect(moveStatements(db)).toBe(moveStatements(db));
      expect(moveStatements(other)).not.toBe(moveStatements(db));

      const first = createMoveStatements(db);
      const second = createMoveStatements(db);
      expect(second.clearMoveIntent).not.toBe(first.clearMoveIntent);
      expect(second.clearMoveIntent).toBe(second.clearMoveIntent);
    } finally {
      other.close();
    }
  });

  it("compiles nothing until a statement is used, and then only that one", () => {
    const statements = createMoveStatements(db);
    const prepare = db.prepare.bind(db);
    const compiled: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      compiled.push(sql.replace(/\s+/g, " ").trim());
      return prepare(sql);
    });

    // Building a bundle must cost nothing, and reading one statement must not
    // drag the rest of the bundle with it: a deployment that never sees a
    // no-UIDPLUS move must never compile the reconciliation statements, and a
    // message without a `remote_id_lookup` must never compile the
    // duplicate-destination pair. Both of those are conditional paths, and
    // compiling ahead of them would turn a conditional into an unconditional.
    expect(compiled).toEqual([]);

    statements.clearMoveIntent.run("nothing-yet");
    expect(compiled).toEqual([
      "UPDATE messages SET pending_move_destination = NULL, pending_move_state = NULL, pending_move_candidate_uid = NULL, pending_move_special_use = NULL WHERE id = ? AND pending_move_state = 'intent'",
    ]);

    statements.clearMoveIntent.run("nothing-yet");
    expect(compiled).toHaveLength(1);
  });

  it("reproduces the duplicate-destination read's exact predicate on both move paths", () => {
    const statements = createMoveStatements(db);
    db.prepare(`
      INSERT INTO messages (id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json, sent_at, created_at)
      VALUES ('kept', 'account-1', 'Archive', 5, 'h1', 's', 'd', 'd@e', '[]', '2026-01-01', '2026-01-01')
    `).run();
    const found = [{
      id: "kept", mailbox: "Archive", uid: 5, remote_id_lookup: "h1", flags_json: "[]", all_mail_archived: null,
    }];

    // The UIDPLUS path recognises the copy by the destination UID; the
    // reconciliation path recognises it by the opaque remote identity. Both
    // are the *first* thing their transaction does, and both exclude the row
    // being moved — a read that kept the moved row would report the message
    // as its own duplicate and tombstone it.
    const duplicate = statements.uidPlusDuplicateRows.all("account-1", "Archive", 5, "kept");
    expect(duplicate).toEqual([]);
    expect(statements.uidPlusDuplicateRows.all("account-1", "Archive", 5, "other")).toEqual(found);

    expect(statements.reconcileDuplicateRows.all("account-1", "Archive", "h1", "kept")).toEqual([]);
    expect(statements.reconcileDuplicateRows.all("account-1", "Archive", "h1", "other")).toEqual(found);
    // ...and neither of them falls back to matching the other identity: a
    // statement that dropped the `uid` / `remote_id_lookup` term would report
    // any same-mailbox row as a duplicate.
    expect(statements.uidPlusDuplicateRows.all("account-1", "Archive", 999, "other")).toEqual([]);
    expect(statements.reconcileDuplicateRows.all("account-1", "Archive", "h2", "other")).toEqual([]);
  });

  it("binds every id in the batch row lookup and interpolates none of them", () => {
    const statements: MoveStatements = createMoveStatements(db);
    const prepare = db.prepare.bind(db);
    const compiled: string[] = [];
    const bound: unknown[][] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("WHERE id IN (")) return statement;
      compiled.push(sql);
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "all") {
            return (...params: unknown[]) => {
              bound.push(params);
              return (target.all as (...args: unknown[]) => unknown[])(...params);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    const ids = ["a", "b", "c"];
    statements.rowsByIds(ids.length).all(...ids);
    statements.rowsByIds(ids.length).all(...ids);
    statements.rowsByIds(ids.length + 1).all(...ids, "d");

    // Two widths, one compiled statement each, and both replayed.
    expect(compiled).toHaveLength(2);
    expect(compiled.map((sql) => (sql.match(/\?/g) ?? []).length)).toEqual([3, 4]);
    // The ids are values, never statement text — that is the whole point.
    for (const sql of compiled) for (const id of ids) expect(sql).not.toContain(`'${id}'`);
    expect(bound).toEqual([ids, ids, [...ids, "d"]]);
  });

  it("caches the destination lookup by `?` count and binds every special use", () => {
    // The bundle is keyed by the placeholder count, never by the target, so a
    // caller must never receive a statement whose width does not match the
    // special uses it is about to bind.
    const statements = createMoveStatements(db);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES ('account-1', 'Trash', 'Trash', '\\Trash')").run();

    expect(statements.destinationBySpecialUseCount(1).get("account-1", "\\Trash"))
      .toEqual({ path: "Trash", special_use: "\\Trash" });
    expect(statements.destinationBySpecialUseCount(1).get("account-1", "\\Junk")).toBeUndefined();
    expect(statements.destinationBySpecialUseCount(2).get("account-1", "\\Archive", "\\All")).toBeUndefined();
    // One object per width, reused for every target of that width.
    expect(statements.destinationBySpecialUseCount(1)).toBe(statements.destinationBySpecialUseCount(1));
    expect(statements.destinationBySpecialUseCount(2)).not.toBe(statements.destinationBySpecialUseCount(1));
    // A mismatched width is the driver's error, not a silently wrong folder.
    expect(() => statements.destinationBySpecialUseCount(1).get("account-1", "\\Archive", "\\All")).toThrow(RangeError);
    expect(() => statements.destinationBySpecialUseCount(2).get("account-1", "\\Trash")).toThrow(RangeError);
  });
});
