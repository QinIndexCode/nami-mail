import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);

/**
 * better-sqlite3 v13 uses an N-API prebuild on supported platforms, so Node
 * and Electron can use the standard resolver without swapping ABI-specific
 * binaries in the project tree.
 */
export function resolveSqliteModuleRequest(): string {
  return "better-sqlite3";
}

export function loadDatabaseConstructor(): typeof BetterSqlite3 {
  return require(resolveSqliteModuleRequest()) as typeof BetterSqlite3;
}
