import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(projectRoot, "apps", "server");
const sourceModule = path.join(projectRoot, "node_modules", "better-sqlite3");
const nodeGypCli = path.join(projectRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
const vitestCli = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
const serverNodeModules = path.join(serverRoot, "node_modules");
const resolverModule = path.join(serverNodeModules, "better-sqlite3");

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath)) throw new Error(`${description} is missing: ${filePath}`);
}

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status ?? "unknown"}: ${args.join(" ")}`);
}

assertFile(sourceModule, "The Electron better-sqlite3 source module");
assertFile(nodeGypCli, "node-gyp");
assertFile(vitestCli, "Vitest");

if (fs.existsSync(resolverModule)) {
  throw new Error(`Refusing to replace an existing server-local better-sqlite3 module: ${resolverModule}`);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-server-test-"));
const temporaryModule = path.join(temporaryRoot, "better-sqlite3");
const serverNodeModulesExisted = fs.existsSync(serverNodeModules);
let ownsResolverModule = false;

try {
  // Build against the command-line Node ABI in a throwaway copy. The Electron
  // binary at the repository root is never replaced or rebuilt.
  fs.cpSync(sourceModule, temporaryModule, { recursive: true });
  runNode([nodeGypCli, "rebuild", "--release"], temporaryModule);

  fs.mkdirSync(serverNodeModules, { recursive: true });
  ownsResolverModule = true;
  fs.cpSync(temporaryModule, resolverModule, { recursive: true });
  runNode([
    "-e",
    "const Database = require('better-sqlite3'); const database = new Database(':memory:'); database.close();",
  ], serverRoot);

  const test = spawnSync(process.execPath, [vitestCli, "run", ...process.argv.slice(2)], {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (test.error) throw test.error;
  process.exitCode = test.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    if (ownsResolverModule) fs.rmSync(resolverModule, { recursive: true, force: true });
    if (!serverNodeModulesExisted && fs.existsSync(serverNodeModules) && fs.readdirSync(serverNodeModules).length === 0) {
      fs.rmdirSync(serverNodeModules);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
    process.exitCode = 1;
  }
}
