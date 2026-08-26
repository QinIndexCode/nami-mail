/**
 * UI stress runner — orchestrates the full stress run:
 *   1. seed a database with N messages (scripts/ui-stress/seed-data.mjs)
 *   2. boot the local API server against that database (apps/server/dist/index.js)
 *   3. run the Playwright stress spec (e2e/ui-stress.spec.ts)
 *   4. shut the server down and print the results file location
 *
 * Usage:
 *   node scripts/ui-stress/run-stress.mjs [--count 20000] [--ratio 0.75] [--grep <test title>]
 *
 * The server port is fixed at 3187; the runner fails fast if it is already in use.
 */

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3187;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const count = Number.parseInt(arg("--count", "20000"), 10) || 20000;
const ratio = Number.parseFloat(arg("--ratio", "0.75")) || 0.75;
const grep = arg("--grep", "");
const dataDir = path.resolve(projectRoot, "data", "ui-stress");

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => socket.destroy() && resolve(true));
    socket.once("error", () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  // The 20k seed database is ~600MB; opening it (plus FTS index warm-up)
  // can take a while on a busy or cold disk, so allow two minutes.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/stats`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`Server did not respond on port ${PORT} within 30s.`);
}

function seal(results) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(dataDir, `results-${timestamp}.json`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  return outputPath;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/ui-stress/run-stress.mjs [--count N] [--ratio R] [--grep title]");
    return;
  }
  if (await portInUse(PORT)) {
    throw new Error(`Port ${PORT} is already in use — stop the other server first.`);
  }
  if (await portInUse(5173)) {
    throw new Error("Port 5173 is already in use — stop an existing Vite dev server first so Playwright boots a fresh one.");
  }

  const results = { seed: null, server: null, playwright: null };

  results.seed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/ui-stress/seed-data.mjs", "--count", String(count), "--ratio", String(ratio), "--dir", dataDir], {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve({ count }) : reject(new Error(`Seeding failed with exit code ${code}.`))));
  });

  const serverEnv = {
    ...process.env,
    DATABASE_PATH: path.join(dataDir, "nami-mail.db"),
    MASTER_KEY_PATH: path.join(dataDir, "master.key"),
    PORT: String(PORT),
  };
  const server = spawn(process.execPath, [path.join(projectRoot, "apps", "server", "dist", "index.js")], {
    cwd: path.join(projectRoot, "apps", "server"),
    env: serverEnv,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  results.server = { pid: server.pid, port: PORT };

  let serverFailure = null;
  server.once("error", (error) => {
    serverFailure = error;
  });

  try {
    await waitForServer();
    const playwrightCli = path.join(projectRoot, "node_modules", "@playwright", "test", "cli.js");
    const spec = spawn(process.execPath, [playwrightCli, "test", "e2e/ui-stress.spec.ts", "--reporter=list", "--workers=1", ...(grep ? ["--grep", grep] : [])], {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    const playwrightExit = await new Promise((resolve) => spec.once("exit", (code) => resolve(code ?? 1)));
    results.playwright = { exitCode: playwrightExit };
  } finally {
    server.kill();
    await sleep(500);
    server.removeAllListeners();
  }

  if (serverFailure) throw serverFailure;

  const specResultsPath = path.join(dataDir, "results-spec.json");
  if (fs.existsSync(specResultsPath)) {
    try {
      results.spec = JSON.parse(fs.readFileSync(specResultsPath, "utf8"));
    } catch {
      // Spec results are best-effort metrics; keep the run summary either way.
    }
  }

  const outputPath = seal(results);
  console.log("");
  console.log(`Stress run finished. Full results: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});