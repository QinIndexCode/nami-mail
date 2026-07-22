import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertWindowsSqlitePrebuild, projectRoot } from "./sqlite-native.mjs";

const require = createRequire(import.meta.url);
const legacyRootFlag = "--legacy-root";
const args = process.argv.slice(2);
const legacyRootIndex = args.indexOf(legacyRootFlag);

if (legacyRootIndex === -1 || legacyRootIndex + 1 >= args.length || args.length !== 2) {
  throw new Error("Usage: node scripts/verify-legacy-sqlite-compat.mjs --legacy-root <older-release-checkout>");
}

const legacyRoot = path.resolve(args[legacyRootIndex + 1]);
assert.notEqual(legacyRoot, projectRoot, "The legacy checkout must be different from the current checkout.");

const legacySqliteManifestPath = path.join(legacyRoot, "node_modules", "better-sqlite3", "package.json");
const legacyElectronExecutable = path.join(legacyRoot, "node_modules", "electron", "dist", "electron.exe");
const currentSqliteManifest = require("better-sqlite3/package.json");
const legacySqliteManifest = JSON.parse(await fs.readFile(legacySqliteManifestPath, "utf8"));
const currentMajor = Number.parseInt(currentSqliteManifest.version.split(".")[0], 10);
const legacyMajor = Number.parseInt(legacySqliteManifest.version.split(".")[0], 10);

assert.ok(Number.isInteger(currentMajor), "The current better-sqlite3 version must have a numeric major version.");
assert.ok(Number.isInteger(legacyMajor), "The legacy better-sqlite3 version must have a numeric major version.");
assert.ok(legacyMajor < currentMajor, `Expected an older better-sqlite3 major than ${currentSqliteManifest.version}; received ${legacySqliteManifest.version}.`);

async function assertLegacyElectronRuntime() {
  try {
    await fs.access(legacyElectronExecutable);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(
      `The legacy Electron runtime is missing. In the isolated legacy worktree, run node node_modules/electron/install.js, then npm.cmd run rebuild:electron before rerunning this command: ${legacyElectronExecutable}`,
    );
  }
}

await assertLegacyElectronRuntime();
assertWindowsSqlitePrebuild();

function assertLegacyElectronSqliteLoadable() {
  const probe = spawnSync(
    legacyElectronExecutable,
    [
      "--eval",
      "const Database = require('better-sqlite3'); const database = new Database(':memory:'); const row = database.prepare('SELECT 12 AS value').get(); database.close(); if (row.value !== 12) process.exit(1); console.log(JSON.stringify({ modules: process.versions.modules, napi: process.versions.napi }));",
    ],
    {
      cwd: legacyRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (probe.error) throw probe.error;
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.stdout || "unknown error").trim();
    throw new Error(
      `The legacy checkout cannot load better-sqlite3 in Electron. This verification never rewrites the legacy checkout. In the isolated legacy worktree, run npm.cmd run rebuild:electron, then rerun this command.${detail ? ` ${detail}` : ""}`,
    );
  }

  let runtime;
  try {
    runtime = JSON.parse(probe.stdout.trim());
  } catch {
    throw new Error(`The legacy Electron SQLite probe returned invalid JSON: ${probe.stdout.trim()}`);
  }
  assert.ok(typeof runtime.modules === "string" && runtime.modules, "The legacy Electron probe did not report a native module ABI.");
  return runtime;
}

const legacyElectronRuntime = assertLegacyElectronSqliteLoadable();

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-mail-legacy-sqlite-"));
const databasePath = path.join(temporaryDirectory, "compatibility.db");
const legacyProbeSource = String.raw`
  const Database = require("better-sqlite3");
  const database = new Database(process.argv.at(-1));
  database.pragma("journal_mode = WAL");
  database.pragma("wal_autocheckpoint = 0");
  database.exec("CREATE TABLE IF NOT EXISTS compatibility_rows (id INTEGER PRIMARY KEY, source TEXT NOT NULL)");
  database.prepare("INSERT INTO compatibility_rows (source) VALUES (?)").run("legacy");
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
  send({ event: "ready", sqliteVersion: database.prepare("SELECT sqlite_version() AS version").get().version });
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    let boundary;
    while ((boundary = input.indexOf("\n")) !== -1) {
      const command = input.slice(0, boundary).trim();
      input = input.slice(boundary + 1);
      if (command === "verify") {
        const count = database.prepare("SELECT COUNT(*) AS count FROM compatibility_rows").get().count;
        const integrity = database.pragma("integrity_check", { simple: true });
        send({ event: "verified", count, integrity });
      }
      if (command === "close") {
        database.close();
        send({ event: "closed" });
        process.exit(0);
      }
    }
  });
`;

function startLegacyProbe() {
  const child = spawn(legacyElectronExecutable, ["--eval", legacyProbeSource, databasePath], {
    cwd: legacyRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let output = "";
  let errorOutput = "";
  let closed = false;
  const messages = [];
  const waiters = [];
  const probeTimeoutMs = 30_000;
  const rejectWaiters = (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };
  const dispatch = (message) => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.event === message.event);
    if (waiterIndex < 0) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  };
  const waitFor = (event) => {
    const messageIndex = messages.findIndex((message) => message.event === event);
    if (messageIndex >= 0) return Promise.resolve(messages.splice(messageIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve, reject, timeout: undefined };
      waiter.timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Legacy SQLite probe did not report ${event} within ${probeTimeoutMs / 1000} seconds.`));
      }, probeTimeoutMs);
      waiters.push(waiter);
    });
  };

  child.stdout.on("data", (chunk) => {
    output += chunk;
    let boundary;
    while ((boundary = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, boundary).trim();
      output = output.slice(boundary + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        rejectWaiters(new Error(`Legacy SQLite probe returned invalid JSON: ${line}`));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-4_000);
  });
  child.once("error", (error) => {
    closed = true;
    rejectWaiters(error);
  });
  child.once("exit", (code, signal) => {
    closed = true;
    const detail = errorOutput.trim();
    const error = new Error(`Legacy SQLite probe exited with ${signal ? `signal ${signal}` : `code ${code}`}.${detail ? ` ${detail}` : ""}`);
    rejectWaiters(error);
  });

  return {
    child,
    waitFor,
    send(command) {
      child.stdin.write(`${command}\n`);
    },
    async close() {
      if (closed) return;
      this.send("close");
      await this.waitFor("closed");
    },
  };
}

let currentDatabase;
let legacyProbe;
try {
  legacyProbe = startLegacyProbe();
  const legacyReady = await legacyProbe.waitFor("ready");
  assert.equal(typeof legacyReady.sqliteVersion, "string", "The legacy SQLite probe did not report its SQLite version.");

  const Database = require("better-sqlite3");
  currentDatabase = new Database(databasePath);
  const initialCount = currentDatabase.prepare("SELECT COUNT(*) AS count FROM compatibility_rows").get().count;
  assert.equal(initialCount, 1, "The current runtime could not read the legacy WAL row.");
  currentDatabase.prepare("INSERT INTO compatibility_rows (source) VALUES (?)").run("current");
  assert.equal(currentDatabase.pragma("integrity_check", { simple: true }), "ok", "The current runtime reported a corrupt legacy database.");
  const checkpoint = currentDatabase.pragma("wal_checkpoint(TRUNCATE)")[0];
  assert.deepEqual(checkpoint, { busy: 0, log: 0, checkpointed: 0 }, "The current runtime could not checkpoint the legacy WAL.");
  currentDatabase.close();
  currentDatabase = undefined;

  const reopenedDatabase = new Database(databasePath);
  try {
    assert.equal(reopenedDatabase.prepare("SELECT COUNT(*) AS count FROM compatibility_rows").get().count, 2, "The current runtime lost rows after reopening the legacy database.");
    assert.equal(reopenedDatabase.pragma("integrity_check", { simple: true }), "ok", "The reopened current database failed integrity_check.");
  } finally {
    reopenedDatabase.close();
  }

  legacyProbe.send("verify");
  const legacyVerified = await legacyProbe.waitFor("verified");
  assert.equal(legacyVerified.count, 2, "The legacy runtime could not read the row written by the current runtime.");
  assert.equal(legacyVerified.integrity, "ok", "The legacy runtime failed integrity_check after the current runtime wrote the database.");
  await legacyProbe.close();

  const currentVersionDatabase = new Database(":memory:");
  const currentSqlite = currentVersionDatabase.prepare("SELECT sqlite_version() AS version").get().version;
  currentVersionDatabase.close();

  console.log(JSON.stringify({
    legacyBetterSqlite3: legacySqliteManifest.version,
    legacySqlite: legacyReady.sqliteVersion,
    legacyElectronAbi: legacyElectronRuntime.modules,
    currentBetterSqlite3: currentSqliteManifest.version,
    currentSqlite,
    walReadWriteCheckpointReopen: true,
  }));
} finally {
  currentDatabase?.close();
  await legacyProbe?.close().catch(() => undefined);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
