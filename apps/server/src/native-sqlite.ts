import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3-multiple-ciphers";

const require = createRequire(import.meta.url);

/**
 * The single place in the server that names the SQLite driver.
 *
 * `better-sqlite3-multiple-ciphers` is the drop-in fork of `better-sqlite3`
 * carrying SQLite3MultipleCiphers. It tracks the same version line and ships
 * the same N-API prebuild, so Node and Electron both resolve it without an
 * ABI-specific binary swap; the difference is that a database may be opened
 * with a key, which turns every page SQLite writes — the FTS5 shadow tables
 * and the WAL included — into ciphertext at rest.
 *
 * Everything else in the server receives the constructor or the `Database`
 * type from here, so the driver identity is one edit and the cipher capability
 * cannot be adopted half-way.
 */
export const SQLITE_MODULE_NAME = "better-sqlite3-multiple-ciphers";

/** Retained as a function for the packaging checks and the selection test. */
export function resolveSqliteModuleRequest(): string {
  return SQLITE_MODULE_NAME;
}

export function loadDatabaseConstructor(): typeof BetterSqlite3 {
  return require(SQLITE_MODULE_NAME) as typeof BetterSqlite3;
}

/** Row and statement types of whichever driver `SQLITE_MODULE_NAME` resolves to. */
export type Database = BetterSqlite3.Database;
