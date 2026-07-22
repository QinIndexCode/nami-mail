import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertWindowsSqlitePrebuild,
  projectRoot,
  sqliteModulePath,
} from "./sqlite-native.mjs";

const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

function hashFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

const prebuildPath = assertWindowsSqlitePrebuild(sqliteModulePath);
assert.ok(fs.existsSync(electronExecutable), `Electron executable is missing: ${electronExecutable}`);

const prebuildHashBefore = hashFile(prebuildPath);
const nodeProbe = run(process.execPath, [
  "--eval",
  "const Database = require('better-sqlite3'); const database = new Database(':memory:'); const row = database.prepare('SELECT 13 AS value').get(); database.close(); if (row.value !== 13) process.exit(1); console.log(process.versions.modules);",
]);
assert.equal(nodeProbe, process.versions.modules, "better-sqlite3 did not load in the command-line Node runtime.");

const electronProbe = run(
  electronExecutable,
  [
    "--eval",
    "const Database = require('better-sqlite3'); const database = new Database(':memory:'); const row = database.prepare('SELECT 13 AS value').get(); database.close(); if (row.value !== 13) process.exit(1); console.log(process.versions.modules);",
  ],
  { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
);
assert.notEqual(electronProbe, nodeProbe, "The Electron and command-line Node ABIs should remain distinct in this checkout.");
assert.equal(
  hashFile(prebuildPath),
  prebuildHashBefore,
  "Loading the shared N-API prebuild changed the installed native module.",
);

console.log(JSON.stringify({
  nodeAbi: nodeProbe,
  electronAbi: electronProbe,
  prebuild: path.relative(projectRoot, prebuildPath),
  sharedPrebuildUnchanged: true,
}));
