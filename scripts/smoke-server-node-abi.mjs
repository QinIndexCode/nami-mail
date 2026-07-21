import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ensureServerNodeSqlite, projectRoot, serverRoot } from "./prepare-server-sqlite.mjs";

const rootNativeModule = path.join(projectRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
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

assert.ok(fs.existsSync(rootNativeModule), `Electron native module is missing: ${rootNativeModule}`);
assert.ok(fs.existsSync(electronExecutable), `Electron executable is missing: ${electronExecutable}`);

const rootHashBefore = hashFile(rootNativeModule);
const nodeModule = ensureServerNodeSqlite();
const serverNodeModules = path.join(serverRoot, "node_modules");
const moduleRelativeToServerNodeModules = path.relative(serverNodeModules, nodeModule);
assert.ok(
  moduleRelativeToServerNodeModules.startsWith("..") || path.isAbsolute(moduleRelativeToServerNodeModules),
  "The Node ABI cache must not live in apps/server/node_modules, where it could shadow Electron.",
);

const nodeProbe = run(process.execPath, [
  "--eval",
  `const Database = require(${JSON.stringify(nodeModule)}); const database = new Database(':memory:'); database.close(); console.log(process.versions.modules);`,
]);
assert.equal(nodeProbe, process.versions.modules, "The isolated module did not load in the command-line Node runtime.");

const electronProbe = run(
  electronExecutable,
  [
    "--eval",
    "const Database = require('better-sqlite3'); const database = new Database(':memory:'); database.close(); console.log(process.versions.modules);",
  ],
  { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
);
assert.notEqual(electronProbe, nodeProbe, "The Electron and command-line Node ABIs should remain distinct in this checkout.");
assert.equal(hashFile(rootNativeModule), rootHashBefore, "Preparing the Node cache changed Electron's native module.");

console.log(JSON.stringify({
  nodeAbi: nodeProbe,
  electronAbi: electronProbe,
  nodeModule: path.relative(projectRoot, nodeModule),
  rootElectronModuleUnchanged: true,
}));
