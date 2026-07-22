import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertWindowsSqlitePrebuild,
  projectRoot,
  sqliteModulePath,
} from "./sqlite-native.mjs";

const electronExecutable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

assert.ok(fs.existsSync(electronExecutable), `Electron executable is missing: ${electronExecutable}`);
const prebuildPath = assertWindowsSqlitePrebuild(sqliteModulePath);

const probe = spawnSync(
  electronExecutable,
  [
    "--eval",
    "const Database = require('better-sqlite3'); const database = new Database(':memory:'); const row = database.prepare('SELECT 13 AS value').get(); database.close(); if (row.value !== 13) process.exit(1); console.log(JSON.stringify({ modules: process.versions.modules, napi: process.versions.napi }));",
  ],
  {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true,
  },
);
if (probe.error) throw probe.error;
if (probe.status !== 0) {
  throw new Error(`Electron SQLite probe failed: ${(probe.stderr || probe.stdout || "unknown error").trim()}`);
}

let runtime;
try {
  runtime = JSON.parse(probe.stdout.trim());
} catch {
  throw new Error(`Electron SQLite probe returned invalid JSON: ${probe.stdout.trim()}`);
}
assert.ok(typeof runtime.modules === "string" && runtime.modules, "Electron did not report a native module ABI.");
assert.ok(typeof runtime.napi === "string" && runtime.napi, "Electron did not report an N-API version.");

console.log(JSON.stringify({
  electronAbi: runtime.modules,
  napi: runtime.napi,
  prebuild: path.relative(projectRoot, prebuildPath),
}));
