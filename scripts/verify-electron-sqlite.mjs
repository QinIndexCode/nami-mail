import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertWindowsSqlitePrebuild,
  projectRoot,
  sqliteModuleName,
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

// Loading the driver is not enough to call the store encrypted at rest: this
// probe also encrypts a throwaway database under the shipped runtime and
// asserts the bytes on disk are not a plaintext SQLite database and that the
// file cannot be read without the key. A revert to plaintext better-sqlite3
// would keep a load-only probe green while shipping cleartext.
const probeSource = `
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const Database = require(${JSON.stringify(sqliteModuleName)});

  const memory = new Database(":memory:");
  const memoryValue = memory.prepare("SELECT 13 AS value").get().value;
  memory.close();
  if (memoryValue !== 13) process.exit(1);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-electron-cipher-"));
  const databasePath = path.join(directory, "probe.db");
  const key = "x'" + crypto.randomBytes(32).toString("hex") + "'";
  const creating = new Database(databasePath);
  creating.pragma('key = "' + key + '"');
  creating.prepare("CREATE TABLE probe (id INTEGER PRIMARY KEY)").run();
  creating.prepare("INSERT INTO probe (id) VALUES (1)").run();
  creating.close();

  const header = fs.readFileSync(databasePath).subarray(0, 16).toString("latin1");
  const reading = new Database(databasePath);
  reading.pragma('key = "' + key + '"');
  const encryptedCount = reading.prepare("SELECT COUNT(*) AS count FROM probe").get().count;
  reading.close();

  // SQLite3MultipleCiphers opens lazily: constructing the connection succeeds
  // and the first page read is what fails without a key. The handle therefore
  // has to be released on both paths, or Windows keeps the file locked.
  let keylessReadRefused = false;
  let keyless = null;
  try {
    keyless = new Database(databasePath);
    keyless.prepare("SELECT COUNT(*) AS count FROM probe").get();
  } catch {
    keylessReadRefused = true;
  } finally {
    if (keyless) {
      try {
        keyless.close();
      } catch {
        // A connection that already failed to read still has to be released.
      }
    }
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      break;
    } catch (error) {
      // Windows can hold the handle for a moment past close() (indexer, AV).
      // Retry a bounded number of times, then surface the real failure.
      if (attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  if (header.startsWith("SQLite format 3")) throw new Error("Electron wrote a plaintext database header.");
  if (encryptedCount !== 1) throw new Error("Electron could not read back its own encrypted database.");
  if (!keylessReadRefused) throw new Error("Electron read an encrypted database without a key.");
  console.log(JSON.stringify({ modules: process.versions.modules, napi: process.versions.napi, cipherRoundTrip: true }));
`;

const probe = spawnSync(
  electronExecutable,
  [
    "--eval",
    probeSource,
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
assert.equal(runtime.cipherRoundTrip, true, "Electron did not complete an encrypted round trip.");

console.log(JSON.stringify({
  electronAbi: runtime.modules,
  napi: runtime.napi,
  prebuild: path.relative(projectRoot, prebuildPath),
  cipherRoundTrip: true,
}));
