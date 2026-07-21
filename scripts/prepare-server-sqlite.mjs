import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverRoot = path.join(projectRoot, "apps", "server");

const sourceModulesRoot = path.join(projectRoot, "node_modules");
const sourceModule = path.join(sourceModulesRoot, "better-sqlite3");
const nodeGypCli = path.join(projectRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
const nativeCacheRoot = path.join(serverRoot, ".native");
const cacheName = `node-abi-${process.versions.modules}`;
const cacheRoot = path.join(nativeCacheRoot, cacheName);
const cacheModule = path.join(cacheRoot, "node_modules", "better-sqlite3");

const CACHE_OWNER = "nami-mail-server-node-sqlite";
const CACHE_VERSION = 1;

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath)) throw new Error(`${description} is missing: ${filePath}`);
}

function commandResult(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    ...options,
  });
}

function runNode(args, cwd) {
  const result = commandResult(process.execPath, args, cwd, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? "unknown"}: ${args.join(" ")}`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function markerBelongsToNami(cacheDirectory) {
  const marker = readJson(path.join(cacheDirectory, ".nami-node-sqlite.json"));
  return marker?.owner === CACHE_OWNER && marker?.version === CACHE_VERSION;
}

function isCacheCompatible(cacheDirectory) {
  const marker = readJson(path.join(cacheDirectory, ".nami-node-sqlite.json"));
  if (
    marker?.owner !== CACHE_OWNER
    || marker?.version !== CACHE_VERSION
    || marker?.nodeAbi !== process.versions.modules
    || marker?.nodeMajor !== process.versions.node.split(".")[0]
  ) {
    return false;
  }

  const modulePath = path.join(cacheDirectory, "node_modules", "better-sqlite3");
  if (!fs.existsSync(modulePath)) return false;

  const probe = commandResult(
    process.execPath,
    [
      "--eval",
      `const Database = require(${JSON.stringify(modulePath)}); const database = new Database(':memory:'); database.close();`,
    ],
    projectRoot,
    { stdio: "pipe" },
  );
  return !probe.error && probe.status === 0;
}

/**
 * Copy the package's production dependency closure beside the rebuilt native
 * module. Loading an absolute module path then remains independent of the
 * root node_modules tree and cannot affect Electron's resolver.
 */
function copyPackageDependencyClosure(packageName, destinationModulesRoot, copied = new Set()) {
  if (copied.has(packageName)) return;
  copied.add(packageName);

  const sourcePackage = path.join(sourceModulesRoot, packageName);
  const destinationPackage = path.join(destinationModulesRoot, packageName);
  const manifestPath = path.join(sourcePackage, "package.json");
  assertFile(manifestPath, `Dependency ${packageName}`);
  fs.cpSync(sourcePackage, destinationPackage, { recursive: true });

  const manifest = readJson(manifestPath);
  for (const dependencyName of Object.keys(manifest?.dependencies ?? {})) {
    copyPackageDependencyClosure(dependencyName, destinationModulesRoot, copied);
  }
}

function buildCache(stagingDirectory) {
  const stagingModulesRoot = path.join(stagingDirectory, "node_modules");
  fs.mkdirSync(stagingModulesRoot, { recursive: true });
  copyPackageDependencyClosure("better-sqlite3", stagingModulesRoot);

  const stagingModule = path.join(stagingModulesRoot, "better-sqlite3");
  runNode([nodeGypCli, "rebuild", "--release"], stagingModule);

  fs.writeFileSync(
    path.join(stagingDirectory, ".nami-node-sqlite.json"),
    `${JSON.stringify({
      owner: CACHE_OWNER,
      version: CACHE_VERSION,
      nodeAbi: process.versions.modules,
      nodeMajor: process.versions.node.split(".")[0],
      nodeVersion: process.version,
    }, null, 2)}\n`,
    "utf8",
  );

  if (!isCacheCompatible(stagingDirectory)) {
    throw new Error("The isolated Node better-sqlite3 build could not be loaded after compilation.");
  }
}

function replaceCache(stagingDirectory) {
  let backupDirectory;
  if (fs.existsSync(cacheRoot)) {
    if (!markerBelongsToNami(cacheRoot)) {
      throw new Error(`Refusing to replace a non-Nami native cache: ${cacheRoot}`);
    }
    backupDirectory = path.join(nativeCacheRoot, `.${cacheName}.backup-${process.pid}-${randomUUID()}`);
    fs.renameSync(cacheRoot, backupDirectory);
  }

  try {
    fs.renameSync(stagingDirectory, cacheRoot);
    if (!isCacheCompatible(cacheRoot)) {
      throw new Error("The replacement Node better-sqlite3 cache could not be loaded.");
    }
    if (backupDirectory) fs.rmSync(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    try {
      if (fs.existsSync(cacheRoot)) fs.rmSync(cacheRoot, { recursive: true, force: true });
      if (backupDirectory && fs.existsSync(backupDirectory)) fs.renameSync(backupDirectory, cacheRoot);
    } catch (restoreError) {
      console.error(restoreError instanceof Error ? restoreError.message : restoreError);
    }
    throw error;
  }
}

export function ensureServerNodeSqlite({ force = false } = {}) {
  if (!force && isCacheCompatible(cacheRoot)) return cacheModule;

  assertFile(sourceModule, "The root better-sqlite3 source module");
  assertFile(nodeGypCli, "node-gyp");

  fs.mkdirSync(nativeCacheRoot, { recursive: true });
  const stagingDirectory = path.join(nativeCacheRoot, `.${cacheName}.staging-${process.pid}-${randomUUID()}`);
  try {
    buildCache(stagingDirectory);
    replaceCache(stagingDirectory);
  } finally {
    if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }

  console.log(`Prepared isolated Node ABI ${process.versions.modules} SQLite module at ${path.relative(projectRoot, cacheModule)}.`);
  return cacheModule;
}

function main() {
  const args = new Set(process.argv.slice(2));
  for (const argument of args) {
    if (argument !== "--check" && argument !== "--force") {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (args.has("--check")) {
    if (!isCacheCompatible(cacheRoot)) {
      throw new Error(`No compatible isolated Node SQLite module was found at ${cacheModule}. Run npm.cmd run prepare:server-sqlite.`);
    }
    console.log(`Isolated Node ABI ${process.versions.modules} SQLite module is ready at ${path.relative(projectRoot, cacheModule)}.`);
    return;
  }

  ensureServerNodeSqlite({ force: args.has("--force") });
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
