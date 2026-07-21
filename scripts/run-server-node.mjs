import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureServerNodeSqlite, projectRoot, serverRoot } from "./prepare-server-sqlite.mjs";

const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

function usage() {
  return "Usage: node scripts/run-server-node.mjs --watch | --start | --script <project-relative script>";
}

function resolveLaunch(argv) {
  const [mode, script] = argv;
  if (mode === "--watch" && argv.length === 1) {
    if (!fs.existsSync(tsxCli)) throw new Error(`tsx is missing: ${tsxCli}`);
    return { command: process.execPath, args: [tsxCli, "watch", "src/index.ts"], cwd: serverRoot };
  }
  if (mode === "--start" && argv.length === 1) {
    const entry = path.join(serverRoot, "dist", "index.js");
    if (!fs.existsSync(entry)) throw new Error(`The built server entry is missing: ${entry}. Run npm.cmd run build first.`);
    return { command: process.execPath, args: [entry], cwd: serverRoot };
  }
  if (mode === "--script" && script && argv.length === 2) {
    const entry = path.resolve(projectRoot, script);
    const relative = path.relative(projectRoot, entry);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(entry)) {
      throw new Error(`The server script must be an existing project file: ${script}`);
    }
    return { command: process.execPath, args: [entry], cwd: projectRoot };
  }
  throw new Error(usage());
}

async function main() {
  const launch = resolveLaunch(process.argv.slice(2));
  const sqliteModule = ensureServerNodeSqlite();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {
      ...process.env,
      NAMI_MAIL_NODE_SQLITE_RUNTIME: "1",
      NAMI_MAIL_NODE_SQLITE_ABI: process.versions.modules,
      NAMI_MAIL_NODE_SQLITE_MODULE: sqliteModule,
    },
    stdio: "inherit",
    windowsHide: true,
  });

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") resolve();
      else reject(new Error(`Server command exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
