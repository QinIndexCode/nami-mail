import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sqliteModulePath = path.join(projectRoot, "node_modules", "better-sqlite3");

const require = createRequire(import.meta.url);

/**
 * Nami Mail ships Windows x64 only. better-sqlite3 v13 provides this N-API
 * prebuild, which both the command-line Node runtime and Electron can load.
 */
export function expectedWindowsSqlitePrebuild(modulePath = sqliteModulePath) {
  return path.join(modulePath, "prebuilds", "win32-x64.node");
}

export function assertWindowsSqlitePrebuild(modulePath = sqliteModulePath) {
  assert.equal(process.platform, "win32", "Nami Mail's SQLite packaging checks require Windows.");
  assert.equal(process.arch, "x64", "Nami Mail's SQLite packaging checks require x64.");

  const prebuildPath = expectedWindowsSqlitePrebuild(modulePath);
  assert.ok(
    fs.existsSync(prebuildPath),
    `better-sqlite3 v13 Windows N-API prebuild is missing: ${prebuildPath}`,
  );
  return prebuildPath;
}

export function querySqliteWithCurrentNode() {
  const Database = require("better-sqlite3");
  const database = new Database(":memory:");
  try {
    const row = database.prepare("SELECT 13 AS value").get();
    assert.deepEqual(row, { value: 13 }, "better-sqlite3 did not execute the N-API SQLite query.");
  } finally {
    database.close();
  }
}
