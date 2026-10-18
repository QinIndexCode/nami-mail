import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The one place the scripts name the SQLite driver, mirroring
 * `apps/server/src/native-sqlite.ts`. `better-sqlite3-multiple-ciphers` is the
 * drop-in fork of better-sqlite3 carrying SQLite3MultipleCiphers, so the
 * packaging and runtime probes below exercise the driver the app actually
 * ships — including its ability to encrypt a database (see
 * verify-electron-sqlite.mjs, whose probe asserts a cipher round trip rather
 * than a mere module load).
 */
export const sqliteModuleName = "better-sqlite3-multiple-ciphers";
export const sqliteModulePath = path.join(projectRoot, "node_modules", sqliteModuleName);

const require = createRequire(import.meta.url);

/**
 * Nami Mail ships Windows x64 only. The driver provides this N-API prebuild,
 * which both the command-line Node runtime and Electron can load.
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
    `${sqliteModuleName} Windows N-API prebuild is missing: ${prebuildPath}`,
  );
  return prebuildPath;
}

export function querySqliteWithCurrentNode() {
  const Database = require(sqliteModuleName);
  const database = new Database(":memory:");
  try {
    const row = database.prepare("SELECT 13 AS value").get();
    assert.deepEqual(row, { value: 13 }, `${sqliteModuleName} did not execute the N-API SQLite query.`);
  } finally {
    database.close();
  }
}
