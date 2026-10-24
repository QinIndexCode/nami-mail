import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, SCHEMA_VERSION, type DatabaseHandle } from "../src/db.js";

/**
 * What a LAUNCH is allowed to do to a database that is already current (G14).
 *
 * Migrations run on every open — that is the whole point of the
 * `CREATE INDEX IF NOT EXISTS` / `ADD COLUMN` steps, which make an old file
 * catch up without a version matrix — but two of them cannot be expressed that
 * way. SQLite matches `CREATE INDEX IF NOT EXISTS` on the NAME alone, so an
 * index whose *shape* changed can only be brought forward by dropping it and
 * creating it again (message-list-indexes.ts). Ungated, that pair rebuilds the
 * two biggest indexes in the schema on every launch, measured at 330-412ms on
 * 48 000 rows, to arrive at a shape the previous launch already built.
 *
 * `openDatabase` therefore exposes the DDL it applies, and these tests read it
 * instead of timing a launch or diffing the schema: the question is not "was
 * the open fast?" but "did those two statements run?", which has one answer and
 * no noise attached. The list is read two ways — as the exact set of destructive
 * statements (there is exactly one, deliberately) and as the pair that must
 * appear once and then never again.
 */

const LIST_INDEXES = ["idx_messages_account_sort_key", "idx_messages_account_effective_mailbox"] as const;
const EVERY_OPEN_DROP = "DROP INDEX IF EXISTS idx_messages_from";

/** Keyed columns of an index, in order, with 1 for DESC. */
function indexKeys(db: DatabaseHandle, name: string): Array<[string, number]> {
  return (db.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{ name: string | null; desc: number; key: number }>)
    .filter((column) => column.key === 1)
    .map((column) => [column.name!, column.desc] as [string, number]);
}

const rebuildsOf = (ddl: string[]): string[] => ddl.filter((sql) => sql.includes(`DROP INDEX IF EXISTS ${LIST_INDEXES[0]}`));

describe("the DDL every launch runs", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function blankDatabasePath(label: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nami-mail-startup-${label}-`));
    temporaryDirectories.push(directory);
    return path.join(directory, "nami-mail.db");
  }

  /** Opens the file and collects every statement the migration run applied. */
  function openCollecting(databasePath: string): { db: DatabaseHandle; ddl: string[] } {
    const ddl: string[] = [];
    const db = openDatabase(databasePath, { onDdl: (sql) => ddl.push(sql) });
    return { db, ddl };
  }

  const stampOf = (db: DatabaseHandle): string => db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get() as string;

  it("rebuilds the account-scoped list indexes on an upgrade and never again (G14)", () => {
    const databasePath = blankDatabasePath("no-rebuild");

    // A file below the stamp the reshape landed in is exactly the case the pair
    // exists for, so the first open of ANY file does run it: v0 counts as
    // "before v3", and the rebuild then leaves the shape certifiably current.
    const first = openCollecting(databasePath);
    expect(rebuildsOf(first.ddl)).toHaveLength(1);
    expect(stampOf(first.db)).toBe(String(SCHEMA_VERSION));
    first.db.close();

    const second = openCollecting(databasePath);
    try {
      // The load-bearing assertion of G14: already current, so nothing here may
      // drop either index. Asserting the two NAMES rather than "no DROP INDEX at
      // all" is deliberate -- the statement below is a real DROP that this build
      // runs on purpose on every open.
      expect(rebuildsOf(second.ddl)).toEqual([]);
      expect(second.ddl).toContain(EVERY_OPEN_DROP);
      // ...and it is the only destructive statement in a steady-state launch.
      // A `DROP TABLE` reaching a current file is the shape of the failure this
      // whole gate is about, and it would show up here rather than as a slow
      // launch nobody attributes to startup DDL.
      expect(second.ddl.filter((sql) => /DROP\b/i.test(sql))).toEqual([EVERY_OPEN_DROP]);

      // Two launches later the list is identical, statement for statement: a
      // step that only ran on the first launch would make these differ.
      const third = openCollecting(databasePath);
      third.db.close();
      expect(third.ddl).toEqual(second.ddl);
      expect(rebuildsOf(third.ddl)).toEqual([]);
    } finally {
      second.db.close();
    }
  });

  it("restamps a file whose install predates the count-column deletion and rebuilds the pair once", () => {
    const databasePath = blankDatabasePath("rewound");
    openCollecting(databasePath).db.close();

    // Rewind only the stamp, leaving the schema current: that is what an install
    // from the previous build looks like from the migration's point of view, and
    // it is the one state that makes the `< 3` guard fire on a healthy file.
    const rewound = openDatabase(databasePath);
    rewound.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'").run();
    rewound.close();

    const upgrade = openCollecting(databasePath);
    const rebuilds = rebuildsOf(upgrade.ddl);
    try {
      expect(rebuilds).toHaveLength(1);
      expect(rebuilds[0]).toContain(`DROP INDEX IF EXISTS ${LIST_INDEXES[1]}`);
      // Rebuilt, not merely created: `IF NOT EXISTS` would have left whatever
      // shape the old build wrote in place, which is why the pair exists.
      expect(rebuilds[0]).toContain(`CREATE INDEX ${LIST_INDEXES[0]}`);
      expect(rebuilds[0]).not.toContain(`CREATE INDEX IF NOT EXISTS ${LIST_INDEXES[0]}`);
      expect(stampOf(upgrade.db)).toBe(String(SCHEMA_VERSION));
      // The folder-table rebuild is guarded by `data_migrations` instead, so
      // rewinding the stamp must not re-run it: two independent guards, and the
      // second one is what keeps a rewound file from copying `folders` again.
      expect(upgrade.ddl.filter((sql) => /DROP TABLE/i.test(sql))).toEqual([]);
    } finally {
      upgrade.db.close();
    }

    const after = openCollecting(databasePath);
    try {
      expect(rebuildsOf(after.ddl)).toEqual([]);
    } finally {
      after.db.close();
    }
  });

  it("pins the list index shapes the rebuild exists to keep current", () => {
    const db = openCollecting(blankDatabasePath("shapes")).db;
    try {
      // `id` as the last term is what makes the list's order total, which the
      // keyset cursor needs in order to say which side of a tie it sits on.
      expect(indexKeys(db, LIST_INDEXES[0])).toEqual([["account_id", 0], ["sort_key", 1], ["id", 1]]);
      // The folder view files a row by its destination, and carries the same
      // sort suffix for the reason above.
      expect(indexKeys(db, LIST_INDEXES[1])).toEqual([["account_id", 0], ["effective_mailbox", 0], ["sort_key", 1], ["id", 1]]);
      // The cross-account view has no account to seek into, so its index is the
      // ordering alone -- measured at 228ms per page as a sorter without it.
      expect(indexKeys(db, "idx_messages_sort_key_id")).toEqual([["sort_key", 1], ["id", 1]]);
    } finally {
      db.close();
    }
  });
});
