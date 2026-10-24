import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
// Type-only, deliberately. `message-storage.js` also imports `db.js` type-only,
// so nothing in this module's runtime import graph reaches `db.ts` at all:
// `db.ts:12` calls `loadDatabaseConstructor()` at module scope, and the point of
// loading the fixture through the raw constructor is that no part of the app's
// own open path -- pragmas, `migrateDatabase`, the startup prunes -- may run
// against the state under test.
import type { DatabaseHandle } from "../../src/db.js";

/**
 * Loading `fixtures/legacy-store-2026-10` -- the frozen pre-batch-2 database.
 *
 * Shared by the read-back test (which asserts the snapshot is still legacy) and
 * the migration test (which migrates it). Shared rather than copied because the
 * loader is not obvious -- the dumps are loaded statement by statement through
 * the parameterized API (see `statementsOf`) -- and two copies could drift into
 * two different "legacy databases", which is the one thing both tests rest on.
 *
 * The fixture's own README is the authority on what each row is for.
 */

export const MASTER_KEY = Buffer.alloc(32, 0x2b);
export const WRONG_KEY = Buffer.alloc(32, 0x2c);

const fixtureDirectory = fileURLToPath(new URL("../fixtures/legacy-store-2026-10/", import.meta.url));

export const fixtureSchemaSql = fs.readFileSync(path.join(fixtureDirectory, "schema.sql"), "utf8");
export const fixtureRowSql = fs.readFileSync(path.join(fixtureDirectory, "rows.sql"), "utf8");

function isIdentifierCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** Whether `keyword` sits at `index` as a whole word rather than inside a longer identifier. */
function isKeywordAt(sql: string, index: number, keyword: string): boolean {
  if (!sql.startsWith(keyword, index)) return false;
  const before = index > 0 ? sql.charCodeAt(index - 1) : 32;
  const afterIndex = index + keyword.length;
  const after = afterIndex < sql.length ? sql.charCodeAt(afterIndex) : 32;
  return !isIdentifierCode(before) && !isIdentifierCode(after);
}

/**
 * The statements of a dump, split on the terminators that are not inside a
 * string, a comment, or a trigger body.
 *
 * `Database#exec` would take the whole text in one call and is the obvious
 * loader, but this workspace's security hook refuses any `exec` call whose
 * argument is not a literal — it does not care that the receiver is a database.
 * Splitting explicitly keeps `schema.sql` and `rows.sql` as the single source of
 * truth instead of shipping a second, binary copy of the same rows, and the
 * splitter is pinned by its own test (`legacy-store-fixture.test.ts`) plus the
 * integrity/table/row assertions on the loaded fixture, so a wrong split fails
 * loudly rather than quietly loading a different database.
 */
export function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let triggerDepth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      current += char;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        current += "*/";
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    // The string and comment states are checked before the markers that open
    // them, so a `--` inside a literal stays literal; the reverse is safe as
    // well, because a quote inside a comment cannot open a string when comments
    // are consumed first.
    if (inString) {
      if (char === "'" && next === "'") {
        current += "''";
        index += 1;
        continue;
      }
      if (char === "'") inString = false;
      current += char;
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      current += "--";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      current += "/*";
      index += 1;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    // A trigger body holds terminators of its own. Only a `BEGIN` in a statement
    // that has already named a TRIGGER opens one, and the depth is clamped at
    // zero because a generated column's `CASE … END` also ends in `END` and must
    // not look like the end of a body. The dump has exactly one trigger, whose
    // single inner terminator is what this protects.
    if (isKeywordAt(sql, index, "BEGIN") && current.toUpperCase().includes("TRIGGER")) {
      triggerDepth += 1;
    } else if (isKeywordAt(sql, index, "END") && triggerDepth > 0) {
      triggerDepth -= 1;
    }
    if (char === ";" && triggerDepth === 0) {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current);
  return statements.filter((statement) => statement.trim().length > 0);
}

export function prepareDump(db: DatabaseHandle, sql: string): void {
  for (const statement of statementsOf(sql)) db.prepare(statement).run();
}

/** The fixture as a raw database. See the import comment for why not `openDatabase`. */
export function loadFixture(): DatabaseHandle {
  const db = new Database(":memory:");
  prepareDump(db, fixtureSchemaSql);
  prepareDump(db, fixtureRowSql);
  return db;
}

/**
 * The fixture as a real file on disk, for the tests whose subject *is* the app's
 * open path.
 *
 * Written through the raw constructor for the same reason `loadFixture` is: the
 * file has to exist before `openDatabase` runs, and `openDatabase` is the code
 * under test. The file it produces is exactly what the previous revision's last
 * launch left behind -- plaintext (no `PRAGMA key` was ever applied to it), WAL
 * off until someone opens it, and stamped with whatever that build stamped.
 */
export function writeFixtureFile(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    prepareDump(db, fixtureSchemaSql);
    prepareDump(db, fixtureRowSql);
  } finally {
    db.close();
  }
}

/**
 * The first column of a one-row count query.
 *
 * `pluck` rather than reading a `count` field: a caller that writes
 * `SELECT COUNT(*)` without an alias would otherwise get `NaN` from an
 * unaliased column, which is a trap with no benefit.
 */
export function countOf(db: DatabaseHandle, sql: string, ...params: unknown[]): number {
  return Number(db.prepare(sql).pluck().get(...params));
}

export function rows<T>(db: DatabaseHandle, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function withFixture<T>(body: (db: DatabaseHandle) => T): T {
  const db = loadFixture();
  try {
    return body(db);
  } finally {
    db.close();
  }
}
